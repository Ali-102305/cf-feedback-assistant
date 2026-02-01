export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Basic HTML escaping for any user-provided content we might display
    const esc = (s) =>
      String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

    const htmlHeaders = { headers: { "Content-Type": "text/html; charset=UTF-8" } };

    const d1MissingResponse = new Response(
      `
      <html><body>
        <h1>Server configuration error</h1>
        <p>D1 binding <code>feedback_db</code> is missing. Check <code>wrangler.jsonc</code>.</p>
        <p><a href="/">Back to home</a></p>
      </body></html>
      `,
      { ...htmlHeaders, status: 500 }
    );

    const aiMissingResponse = new Response(
      `
      <html><body>
        <h1>Server configuration error</h1>
        <p>Workers AI binding <code>AI</code> is missing. Add <code>"ai": { "binding": "AI" }</code> in <code>wrangler.jsonc</code>.</p>
        <p><a href="/">Back to home</a></p>
      </body></html>
      `,
      { ...htmlHeaders, status: 500 }
    );

    const kvMissingResponse = new Response(
      `
      <html><body>
        <h1>Server configuration error</h1>
        <p>KV binding <code>INSIGHTS_CACHE</code> is missing. Add a KV namespace binding in <code>wrangler.jsonc</code>.</p>
        <p><a href="/">Back to home</a></p>
      </body></html>
      `,
      { ...htmlHeaders, status: 500 }
    );

    // Home page
    if (url.pathname === "/") {
      return new Response(
        `
        <html>
          <head><title>Cloudflare Feedback Assistant</title></head>
          <body>
            <h1>Cloudflare Feedback Assistant</h1>
            <p>
              This tool helps product teams analyse and summarise user feedback
              from multiple sources using Cloudflare Workers and AI.
            </p>
            <ul>
              <li><a href="/submit">Submit feedback</a></li>
              <li><a href="/insights">View insights</a></li>
              <li><a href="/seed">Seed mock data</a></li>
            </ul>
          </body>
        </html>
        `,
        htmlHeaders
      );
    }

    // Submit page
    if (url.pathname === "/submit") {
      return new Response(
        `
        <html>
          <head><title>Submit Feedback</title></head>
          <body>
            <h1>Submit Feedback</h1>

            <form method="POST" action="/api/feedback">
              <label>
                Source:
                <select name="source">
                  <option>Support</option>
                  <option>GitHub</option>
                  <option>Discord</option>
                  <option>Twitter</option>
                </select>
              </label>
              <br /><br />

              <label>
                Feedback:
                <br />
                <textarea name="text" rows="6" cols="50" required></textarea>
              </label>
              <br /><br />

              <button type="submit">Submit</button>
            </form>

            <p><a href="/">Back to home</a></p>
          </body>
        </html>
        `,
        htmlHeaders
      );
    }

    // API: receive feedback + store in D1
    if (url.pathname === "/api/feedback" && request.method === "POST") {
      const formData = await request.formData();
      const source = formData.get("source");
      const text = formData.get("text");

      if (!source || !text || String(text).trim().length === 0) {
        return new Response(
          `
          <html><body>
            <h1>Missing data</h1>
            <p>Please provide both a source and feedback text.</p>
            <p><a href="/submit">Back to submit</a></p>
          </body></html>
          `,
          { ...htmlHeaders, status: 400 }
        );
      }

      if (!env?.feedback_db) return d1MissingResponse;

      const createdAt = new Date().toISOString();

      try {
        await env.feedback_db
          .prepare("INSERT INTO feedback (source, text, created_at) VALUES (?, ?, ?)")
          .bind(String(source), String(text), createdAt)
          .run();
      } catch (err) {
        // NOTE: if you ever see this, it’s usually a table name / SQL error.
        return new Response(
          `
          <html><body>
            <h1>Database error</h1>
            <p>Failed to save feedback. Please try again later.</p>
            <details><summary>Technical details</summary><pre>${esc(err)}</pre></details>
            <p><a href="/">Back to home</a></p>
          </body></html>
          `,
          { ...htmlHeaders, status: 500 }
        );
      }

      // After saving, invalidate cached AI summary so insights refreshes quickly
      // (We use a fixed key; simplest robust approach)
      try {
        if (env?.INSIGHTS_CACHE) {
          await env.INSIGHTS_CACHE.delete("ai_summary:v1");
          await env.INSIGHTS_CACHE.delete("ai_summary_meta:v1");
        }
      } catch (_) {
        // cache invalidation failure should not block user
      }

      return new Response(
        `
        <html><body>
          <h1>Feedback saved ✅</h1>
          <p>Thank you for your feedback.</p>
          <p><a href="/">Back to home</a></p>
          <p><a href="/submit">Submit another</a></p>
          <p><a href="/insights">View insights</a></p>
        </body></html>
        `,
        htmlHeaders
      );
    }

    // Insights page: counts + latest + AI summary (cached in KV)
    if (url.pathname === "/insights") {
      if (!env?.feedback_db) return d1MissingResponse;
      if (!env?.AI) return aiMissingResponse;
      if (!env?.INSIGHTS_CACHE) return kvMissingResponse;

      try {
        // 1) Fetch latest 20 for the table
        const latest = await env.feedback_db
          .prepare("SELECT id, source, text, created_at FROM feedback ORDER BY id DESC LIMIT 20")
          .all();

        // 2) Counts by source
        const counts = await env.feedback_db
          .prepare("SELECT source, COUNT(*) as count FROM feedback GROUP BY source ORDER BY count DESC")
          .all();

        // 3) Compute "version" of data so we know if cached summary is stale
        const versionRow = await env.feedback_db
          .prepare("SELECT MAX(id) AS max_id, COUNT(*) AS total FROM feedback")
          .first();

        const maxId = versionRow?.max_id ?? 0;
        const total = versionRow?.total ?? 0;

        const rows = latest?.results ?? [];
        const sourceCounts = counts?.results ?? [];

        // 4) Try read cached AI summary (KV)
        const cachedMetaRaw = await env.INSIGHTS_CACHE.get("ai_summary_meta:v1");
        const cachedMeta = cachedMetaRaw ? JSON.parse(cachedMetaRaw) : null;

        let aiSummary = await env.INSIGHTS_CACHE.get("ai_summary:v1");
        const cacheFresh =
          cachedMeta && cachedMeta.maxId === maxId && cachedMeta.total === total;

        // 5) If no cache or stale cache, rebuild summary from recent feedback
        if (!aiSummary || !cacheFresh) {
          // Pull a bit more text for the AI summary (latest 50)
          const recent = await env.feedback_db
            .prepare("SELECT source, text FROM feedback ORDER BY id DESC LIMIT 50")
            .all();

          const recentRows = recent?.results ?? [];
          const feedbackBlob =
            recentRows.length === 0
              ? "No feedback available."
              : recentRows
                  .map((r, i) => `${i + 1}. [${r.source}] ${r.text}`)
                  .join("\n");

          const prompt = `
You are a product analyst. Summarise user feedback for a product team.

Return the output in this exact structure:

Executive summary (2-3 sentences):
- ...

Top themes (3-6 bullets):
- Theme: short explanation

Sentiment:
- Overall: Positive/Neutral/Negative
- Confidence (0-100): number
- Evidence: 2 short quotes from the feedback

Top recommended actions (3-5 bullets):
- Action: why it matters

Here is the feedback (most recent first):
${feedbackBlob}
          `.trim();

          // Workers AI call
          const model = "@cf/meta/llama-3-8b-instruct";

          const aiResult = await env.AI.run(model, {
            messages: [
              { role: "system", content: "You are concise, structured, and practical." },
              { role: "user", content: prompt },
            ],
          });

          // Depending on model response shape, use common fields safely
          const aiText =
            aiResult?.response ||
            aiResult?.result ||
            aiResult?.output ||
            JSON.stringify(aiResult);

          aiSummary = String(aiText);

          // Cache for 10 minutes + store meta for staleness detection
          await env.INSIGHTS_CACHE.put("ai_summary:v1", aiSummary, { expirationTtl: 600 });
          await env.INSIGHTS_CACHE.put(
            "ai_summary_meta:v1",
            JSON.stringify({ maxId, total, cachedAt: new Date().toISOString() }),
            { expirationTtl: 600 }
          );
        }

        // Render counts
        const countsHtml =
          sourceCounts.length === 0
            ? "<p><em>No feedback yet.</em></p>"
            : `
              <ul>
                ${sourceCounts
                  .map((r) => `<li><strong>${esc(r.source)}:</strong> ${esc(r.count)}</li>`)
                  .join("")}
              </ul>
            `;

        // Render latest table
        const tableHtml =
          rows.length === 0
            ? "<p><em>No feedback submissions yet. Try <a href='/submit'>submitting feedback</a>.</em></p>"
            : `
              <table border="1" cellpadding="6" cellspacing="0">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Source</th>
                    <th>Feedback</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows
                    .map(
                      (r) => `
                        <tr>
                          <td>${esc(r.id)}</td>
                          <td>${esc(r.source)}</td>
                          <td>${esc(r.text)}</td>
                          <td>${esc(r.created_at)}</td>
                        </tr>
                      `
                    )
                    .join("")}
                </tbody>
              </table>
            `;

        // Render AI summary (pre block keeps formatting)
        const aiHtml = `
          <h2>AI summary (cached)</h2>
          <p><small>Uses Workers AI + KV cache (10 min). Auto-refreshes when new feedback arrives.</small></p>
          <pre style="white-space: pre-wrap; border: 1px solid #ddd; padding: 12px;">${esc(aiSummary)}</pre>
        `;

        return new Response(
          `
          <html>
            <head><title>Insights</title></head>
            <body>
              <h1>Insights</h1>

              ${aiHtml}

              <h2>Feedback by source</h2>
              ${countsHtml}

              <h2>Latest feedback (last 20)</h2>
              ${tableHtml}

              <p><a href="/">Back to home</a></p>
            </body>
          </html>
          `,
          htmlHeaders
        );
      } catch (err) {
        return new Response(
          `
          <html><body>
            <h1>Insights error</h1>
            <p>Could not load insights.</p>
            <details><summary>Technical details</summary><pre>${esc(err)}</pre></details>
            <p><a href="/">Back to home</a></p>
          </body></html>
          `,
          { ...htmlHeaders, status: 500 }
        );
      }
    }
    // Seed page (UI)
    if (url.pathname === "/seed") {
      return new Response(
        `
        <html>
          <head><title>Seed mock data</title></head>
          <body>
            <h1>Seed mock feedback data</h1>
            <p>
              This will insert a realistic set of mock feedback across multiple channels
              (Support, GitHub, Discord, Email, X/Twitter, Community forums) into D1.
            </p>

            <form method="POST" action="/api/seed">
              <button type="submit">Seed mock data</button>
            </form>

            <p><a href="/">Back to home</a></p>
          </body>
        </html>
        `,
        htmlHeaders
      );
    }

    // Seed endpoint (writes to D1)
    if (url.pathname === "/api/seed" && request.method === "POST") {
      if (!env?.feedback_db) return d1MissingResponse;

      // A realistic dataset: noisy, mixed sentiment, varied urgency, feature requests, bugs, billing, UX.
      // We store them in your existing schema: (source, text, created_at)
      const mock = [
        // Support tickets
        { source: "Support", text: "After the last update, I can’t log in on mobile — stuck on a spinning loader." },
        { source: "Support", text: "Billing page shows 'Payment failed' but card was charged. Please fix ASAP." },
        { source: "Support", text: "Can we export audit logs to CSV? Needed for compliance reporting." },
        { source: "Support", text: "Latency spikes in EU region around 6–8pm. Is there a status page incident?" },
        { source: "Support", text: "The UI is clean, but it takes too many clicks to find project settings." },

        // Discord community
        { source: "Discord", text: "Love the new dashboard, but can we get dark mode? 🙏" },
        { source: "Discord", text: "Docs are confusing for first-time setup — a step-by-step wizard would help." },
        { source: "Discord", text: "Seeing random 1101 errors when posting large payloads. Any limits?" },
        { source: "Discord", text: "Feature request: add webhook notifications for deploy success/fail." },
        { source: "Discord", text: "Is there a way to roll back to previous deployment quickly?" },

        // GitHub issues
        { source: "GitHub", text: "Bug: /insights throws 500 when there are 0 rows in the database." },
        { source: "GitHub", text: "Enhancement: add search + filter by source in insights table." },
        { source: "GitHub", text: "Bug: special characters in feedback cause weird encoding on confirmation page." },
        { source: "GitHub", text: "Question: how do we configure rate limits for the API endpoints?" },
        { source: "GitHub", text: "Feature: add tags (bug/feature/billing) to feedback submissions." },

        // Email
        { source: "Email", text: "Hi team — we need SSO (SAML/OAuth) support for enterprise rollout next quarter." },
        { source: "Email", text: "Can you share a roadmap? We’re deciding whether to standardise on your platform." },
        { source: "Email", text: "The setup was easy, but error messages don’t tell me what to do next." },
        { source: "Email", text: "Could you add role-based access control? Different teams need different permissions." },
        { source: "Email", text: "We’d like weekly summary reports sent to stakeholders automatically." },

        // X/Twitter
        { source: "Twitter", text: "Great product! Setup took 5 mins. Please add more examples for real apps." },
        { source: "Twitter", text: "Why is the dashboard so slow today? Anyone else seeing issues?" },
        { source: "Twitter", text: "Love the concept but the pricing page is confusing 😅" },
        { source: "Twitter", text: "Feature request: allow custom domains without extra steps." },
        { source: "Twitter", text: "Bug: I get logged out randomly when switching tabs." },

        // Community forum
        { source: "Community", text: "Guide request: best practices for structuring projects for larger teams." },
        { source: "Community", text: "We need better observability: traces + easy error breakdown by route." },
        { source: "Community", text: "The AI summary is useful — can it also highlight urgency and business impact?" },
        { source: "Community", text: "How do I migrate from another provider? Any import tool planned?" },
        { source: "Community", text: "Please add regional data residency options for regulated industries." },

        // Mixed “noisy” feedback / duplicates / short comments
        { source: "Discord", text: "Can confirm logout bug on Chrome." },
        { source: "Support", text: "Ticket: 2FA codes not arriving via email (spam folder checked)." },
        { source: "GitHub", text: "Docs typo on setup page: 'wranger' should be 'wrangler'." },
        { source: "Community", text: "Any plans for mobile-friendly admin UI?" },
        { source: "Email", text: "Our security team needs a list of sub-processors + SOC2 status." },

        // A few clearly negative and urgent signals
        { source: "Support", text: "URGENT: Production deploy is failing with 'permission denied' even for admins." },
        { source: "Twitter", text: "Service down? Getting errors across multiple endpoints. #incident" },
        { source: "Discord", text: "We lost access to our project after renaming. Please help." },

        // A few clearly positive signals
        { source: "GitHub", text: "Kudos: the DX is excellent — fastest setup I’ve used this year." },
        { source: "Community", text: "The AI insights are genuinely helpful for triaging feedback." },
        { source: "Email", text: "Great support experience — resolved our issue in under an hour." },

        // More “feature request” noise
        { source: "Discord", text: "Can we integrate with Slack for alerts?" },
        { source: "Community", text: "Request: bulk delete / archive old feedback." },
        { source: "GitHub", text: "Feature: add pagination to insights table." },
        { source: "Support", text: "Can you add attachments/screenshots to feedback submissions?" },
        { source: "Email", text: "Need API access to export feedback data into our BI tools." }
      ];

      // Insert with slightly staggered timestamps so it looks like it flowed in over days
      const now = Date.now();
      const minutesBetween = 35;

      try {
        const stmt = env.feedback_db.prepare(
          "INSERT INTO feedback (source, text, created_at) VALUES (?, ?, ?)"
        );

        for (let i = 0; i < mock.length; i++) {
          const createdAt = new Date(now - i * minutesBetween * 60 * 1000).toISOString();
          await stmt.bind(mock[i].source, mock[i].text, createdAt).run();
        }

        // Invalidate AI cache so the summary reflects new data immediately
        if (env?.INSIGHTS_CACHE) {
          await env.INSIGHTS_CACHE.delete("ai_summary:v1");
          await env.INSIGHTS_CACHE.delete("ai_summary_meta:v1");
        }

        return new Response(
          `
          <html>
            <body>
              <h1>Mock data seeded ✅</h1>
              <p>Inserted <strong>${mock.length}</strong> feedback items across multiple channels.</p>
              <p><a href="/insights">Go to insights</a></p>
              <p><a href="/">Back to home</a></p>
            </body>
          </html>
          `,
          htmlHeaders
        );
      } catch (err) {
        return new Response(
          `
          <html>
            <body>
              <h1>Seeding failed</h1>
              <details>
                <summary>Technical details</summary>
                <pre>${esc(err)}</pre>
              </details>
              <p><a href="/">Back to home</a></p>
            </body>
          </html>
          `,
          { ...htmlHeaders, status: 500 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
