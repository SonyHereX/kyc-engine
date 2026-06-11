export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { nameA, nameB } = req.body;

    const prompt = `You are a KYC name verification system. Analyze if these two names refer to the same person, allowing for common spelling variations (like Kathrina vs Kathreena), initials expansion (like K vs Kumar/Kavita), missing middle names/surnames, titles, and regional formats.
Return ONLY valid JSON (no markdown formatting, no codeblocks):
{
  "match": true/false,
  "reason": "short explanation of the decision"
}

Name 1: "${nameA}"
Name 2: "${nameB}"`;

    const nvidiaRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        messages: [{ role: "user", content: prompt }],
        temperature: 1,
        top_p: 0.95,
        max_tokens: 16384,
        extra_body: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 16384 }
      })
    });

    if (!nvidiaRes.ok) throw new Error(`NVIDIA HTTP ${nvidiaRes.status}`);
    const data = await nvidiaRes.json();
    
    let text = data.choices[0].message.content;
    if (!text) {
        text = "{}";
    }

    let cleanText = text.trim();
    if (cleanText.startsWith("```json")) cleanText = cleanText.substring(7);
    if (cleanText.startsWith("```")) cleanText = cleanText.substring(3);
    if (cleanText.endsWith("```")) cleanText = cleanText.substring(0, cleanText.length - 3);
    cleanText = cleanText.trim();

    return res.status(200).json(JSON.parse(cleanText));
  } catch (error) {
    console.error("NVIDIA API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
