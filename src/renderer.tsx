import { jsxRenderer } from 'hono/jsx-renderer'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>aviator-bot dashboard</title>
        <link href="https://cdn.tailwindcss.com" rel="preload" as="script" />
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body class="bg-gray-50 text-gray-900">
        <div class="max-w-4xl mx-auto p-6">
          <h1 class="text-2xl font-bold mb-4">Aviator Signals</h1>
          <ul id="signals" class="space-y-1 mb-8"></ul>
          {children}
        </div>
        <script src="/static/app.js"></script>
      </body>
    </html>
  )
})
