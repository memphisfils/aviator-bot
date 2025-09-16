import { jsxRenderer } from 'hono/jsx-renderer'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>aviator-bot dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" rel="stylesheet" />
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body class="bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-slate-100 min-h-screen">
        <nav class="border-b border-white/10 backdrop-blur sticky top-0 z-10">
          <div class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <i class="fa-solid fa-plane-up text-emerald-400"></i>
              <span class="font-semibold tracking-wide">Aviator Bot</span>
            </div>
            <div id="stats" class="text-sm text-slate-300"></div>
          </div>
        </nav>
        <main class="max-w-6xl mx-auto p-6">
          <section class="mb-6">
            <h1 class="text-2xl font-bold flex items-center gap-2">
              <i class="fa-solid fa-signal text-emerald-400"></i>
              Derniers signaux
            </h1>
            <p class="text-slate-300 text-sm">Flux temps réel des signaux prédits (SSE)</p>
          </section>
          <ul id="signals" class="space-y-2 mb-8"></ul>
          {children}
        </main>
        <footer class="border-t border-white/10 py-6 text-center text-xs text-slate-400">
          © 2025 Aviator Bot — Dashboard Cloudflare Workers
        </footer>
        <script src="/static/app.js"></script>
      </body>
    </html>
  )
})
