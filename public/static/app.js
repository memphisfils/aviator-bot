function el(tag, cls, text) {
  const x = document.createElement(tag)
  if (cls) x.className = cls
  if (text) x.textContent = text
  return x
}

function renderSignal(it) {
  const wrap = el('li', 'flex items-center justify-between p-3 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition')
  const left = el('div')
  const right = el('div', 'text-right')

  const header = el('div', 'text-sm text-gray-500')
  const time = new Date(it.timestamp).toLocaleTimeString()
  header.textContent = `${time} • ${it.platform}`

  const title = el('div', 'font-semibold text-gray-800')
  const conf = Math.round((it.confidence || 0) * 100)
  title.textContent = `${it.predicted_class.toUpperCase()} (${conf}%)`

  left.appendChild(header)
  left.appendChild(title)

  const badge = el('span', 'inline-flex items-center px-2 py-1 rounded text-xs font-medium')
  if (it.recommended_action === 'BET') {
    badge.classList.add('bg-emerald-50','text-emerald-700','border','border-emerald-200')
    badge.textContent = 'BET'
  } else if (it.recommended_action === 'HOLD') {
    badge.classList.add('bg-amber-50','text-amber-700','border','border-amber-200')
    badge.textContent = 'HOLD'
  } else {
    badge.classList.add('bg-gray-100','text-gray-700','border','border-gray-200')
    badge.textContent = 'WAIT'
  }

  const sub = el('div', 'text-xs text-gray-500 mt-1')
  const cash = Array.isArray(it.cashout_targets) ? it.cashout_targets : []
  if (cash.length) sub.textContent = `Targets: ${cash.join(', ')}`

  right.appendChild(badge)
  right.appendChild(sub)

  wrap.appendChild(left)
  wrap.appendChild(right)
  return wrap
}

async function loadLatest() {
  const res = await fetch('/api/signals/latest?limit=20')
  const data = await res.json()
  const list = document.getElementById('signals')
  list.innerHTML = ''
  for (const it of data.items || []) list.appendChild(renderSignal(it))
}

function startSSE() {
  const ev = new EventSource('/api/signals/stream')
  ev.onmessage = (e) => {
    try {
      const it = JSON.parse(e.data)
      const list = document.getElementById('signals')
      list.prepend(renderSignal(it))
      while (list.children.length > 50) list.removeChild(list.lastChild)
    } catch {}
  }
}

async function loadStats() {
  const el = document.getElementById('stats')
  try {
    const res = await fetch('/api/stats')
    const data = await res.json()
    el.textContent = `Total: ${data.total} • Dernier: ${data.lastTs ? new Date(data.lastTs).toLocaleTimeString() : '—'}`
  } catch {
    el.textContent = ''
  }
}

window.addEventListener('DOMContentLoaded', () => {
  loadLatest()
  loadStats()
  setInterval(loadStats, 5000)
  startSSE()
})
