const $ = id => document.getElementById(id);
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
let loading = false;
async function refresh() {
  if (loading || $('logs').open) return;
  loading = true;
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Status is unavailable. Retry shortly.');
    const data = await response.json();
    $('notice').textContent = data.error ?? '';
    $('empty').hidden = data.instances.length !== 0;
    $('instances').replaceChildren();
    for (const item of data.instances) {
      const section = element('section');
      const top = element('div', undefined, 'top');
      const title = element('div'); title.append(element('h2', item.name), element('div', `${item.provider} · ${item.host}${item.environment ? ` · ${item.environment}` : ''}`, 'sub'));
      const state = !item.running ? 'Stopped' : item.connected ? 'Connected' : 'Reconnecting';
      top.append(title, element('span', state, `badge${item.connected ? '' : ' off'}`));
      section.append(top);
      const services = element('div', undefined, 'services');
      for (const [name, service] of Object.entries(item.services)) {
        const row = element('div', undefined, 'service'); row.append(element('strong', name));
        const url = service.httpsUrl ?? service.url;
        if (url?.startsWith('http')) { const link = element('a', url); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
        else row.append(element('span', url ?? 'Internal service', 'address sub'));
        const actions = element('div', undefined, 'actions');
        actions.append(element('span', item.status?.[name] ?? '', 'sub'));
        const button = element('button', 'Logs'); button.setAttribute('aria-label', `Read ${item.name} ${name} logs`);
        button.onclick = async () => {
          $('log-title').textContent = `${item.name} / ${name}`; $('log-body').textContent = 'Loading logs...'; $('logs').showModal();
          try { const response = await fetch(`/api/logs?name=${encodeURIComponent(item.name)}&service=${encodeURIComponent(name)}`); const data = await response.json(); $('log-body').textContent = data.output ?? data.error ?? 'No logs yet.'; }
          catch { $('log-body').textContent = 'Could not read logs.'; }
        };
        actions.append(button); row.append(actions); services.append(row);
      }
      section.append(services);
      if (item.error) section.append(element('p', item.error, 'hint error'));
      else if (item.sync) section.append(element('p', `Sync: ${item.sync}`, 'hint'));
      $('instances').append(section);
    }
    $('updated').textContent = `Local access only · Updated ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())} BCN`;
  } catch (error) { $('notice').textContent = error.message; }
  finally { loading = false; }
}
$('refresh').onclick = refresh;
$('close').onclick = () => $('logs').close();
$('auto').checked = localStorage.getItem('dev-now-auto-refresh') === 'true';
$('auto').onchange = () => localStorage.setItem('dev-now-auto-refresh', String($('auto').checked));
setInterval(() => { if ($('auto').checked && !document.hidden) refresh(); }, 5000);
refresh();
