// Vercel serverless function — receives the project questionnaire's
// answers and emails them via Resend.
//
// Requires a RESEND_API_KEY environment variable set in the Vercel
// project settings (Project → Settings → Environment Variables).
// Get a key at https://resend.com/api-keys — the free tier is plenty
// for this volume.
//
// By default this sends "from" Resend's shared sandbox address, which
// works immediately with no setup. Once studio-juicebox.com is a
// verified sending domain in Resend (Domains → Add Domain), swap the
// FROM_ADDRESS below for something like
// "Juicebox <questionnaire@studio-juicebox.com>".

const FROM_ADDRESS = "Juicebox Questionnaire <onboarding@resend.dev>";
const TO_ADDRESS = "hello@studio-juicebox.com";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const data = req.body || {};
  const subject = data._subject || "New questionnaire submission";

  const html = Object.entries(data)
    .filter(([key]) => key !== "_subject")
    .map(
      ([question, answer]) =>
        `<p><strong>${escapeHtml(question)}</strong><br>${escapeHtml(
          String(answer || "")
        ).replace(/\n/g, "<br>")}</p>`
    )
    .join("");

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: TO_ADDRESS,
        subject,
        html: html || "<p>(no answers submitted)</p>",
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("Resend error:", resendRes.status, errText);
      // TEMP: surfacing the real Resend error to diagnose a delivery
      // failure. Remove the `detail` field once this is working.
      res.status(502).json({ error: "Failed to send email", detail: errText, status: resendRes.status });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Submit handler error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
