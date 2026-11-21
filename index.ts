// Supabase Edge Function: server-side Claude integration.
// The API key lives only in function secrets. Data is fetched with the CALLER's JWT,
// so Row Level Security limits what the model can ever see.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM = `You are the Family Care Hub assistant. Help with family schedules, tasks, expenses, reminders and plain-language explanations of documents the user provides.
Rules: never diagnose diseases, never prescribe or change medication or doses; for medical concerns advise consulting a qualified doctor, and for emergencies advise contacting local emergency services. Use only the family data provided below; if something is not in it, say you don't have it.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } },
    })
    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData.user) return json({ error: 'Unauthorized' }, 401)

    const { message, familyId } = await req.json()
    if (typeof message !== 'string' || !message.trim() || message.length > 2000 || !familyId)
      return json({ error: 'Invalid input' }, 400)

    // RLS enforces membership: a non-member gets empty results.
    const today = new Date().toISOString().slice(0, 10)
    const [appts, tasks, meds, exp] = await Promise.all([
      supabase.from('appointments').select('doctor_name,hospital,reason,starts_at,status').eq('family_id', familyId).gte('starts_at', today).limit(20),
      supabase.from('family_tasks').select('title,status,due_date').eq('family_id', familyId).limit(30),
      supabase.from('medications').select('name,dosage,frequency,end_date').eq('family_id', familyId).limit(30),
      supabase.from('expenses').select('kind,category,amount,spent_on').eq('family_id', familyId).order('spent_on', { ascending: false }).limit(50),
    ])
    const context = JSON.stringify({ appointments: appts.data, tasks: tasks.data, medications: meds.data, expenses: exp.data })

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: Deno.env.get('CLAUDE_MODEL') ?? 'claude-sonnet-5-5',
        max_tokens: 800,
        system: `${SYSTEM}\n\nFamily data (JSON):\n${context}`,
        messages: [{ role: 'user', content: message }],
      }),
    })
    if (!res.ok) return json({ error: 'AI service error' }, 502)
    const out = await res.json()
    const reply = out.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? ''

    await supabase.from('audit_logs').insert({
      family_id: familyId, user_id: userData.user.id, action: 'ai_query', entity: 'ai',
    })
    return json({ reply })
  } catch (_e) {
    return json({ error: 'Server error' }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })
}
