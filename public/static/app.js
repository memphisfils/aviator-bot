async function loadLatest() {
  const res = await fetch('/api/signals/latest?limit=20')
  const data = await res.json()
  const list = document.getElementById('signals')
  list.innerHTML = ''
  for (const it of data.items || []) {
    const li = document.createElement('li')
    li.textContent = `${new Date(it.timestamp).toLocaleTimeString()} [${it.platform}] ${it.predicted_class} (${Math.round((it.confidence||0)*100)}%)`
    list.appendChild(li)
  }
}

function startSSE() {
  const ev = new EventSource('/api/signals/stream')
  ev.onmessage = (e) => {
    try {
      const it = JSON.parse(e.data)
      const list = document.getElementById('signals')
      const li = document.createElement('li')
      li.textContent = `${new Date(it.timestamp).toLocaleTimeString()} [${it.platform}] ${it.predicted_class} (${Math.round((it.confidence||0)*100)}%)`
      list.prepend(li)
    } catch {}
  }
}

window.addEventListener('DOMContentLoaded', () => {
  loadLatest()
  startSSE()
})
