(() => {
  'use strict';
  // Hues follow the Mixed In Key Camelot wheel. A is pastel, B is more saturated.
  // https://mixedinkey.com/workflows/how-to-use-the-camelot-wheel/
  const colors = {
    '1A': '#b3f9de', '1B': '#85ffbd', '2A': '#cff9b1', '2B': '#99ff95',
    '3A': '#d6f5a1', '3B': '#bbf971', '4A': '#e7dfa2', '4B': '#dedc7e',
    '5A': '#f6c3a7', '5B': '#ffa57c', '6A': '#f7adb5', '6B': '#ff869c',
    '7A': '#edacd0', '7B': '#fb84c2', '8A': '#ddabe5', '8B': '#e28af4',
    '9A': '#c8aafa', '9B': '#c894ff', '10A': '#bbbaf6', '10B': '#a6a0ff',
    '11A': '#a9deec', '11B': '#78cce9', '12A': '#adf3ee', '12B': '#70f0e7'
  };
  const tempo = data => data?.bpm ? String(data.bpmRange?.join('–') || data.bpm) : '—';
  const label = data => `${data?.approximate ? '≈ ' : ''}${tempo(data)} · ${data?.key || '—'}${data?.uncertain ? ' ?' : ''}`;
  function render(node, data) {
    const pill = (value, background) => {
      const span = document.createElement('span'); span.textContent = value;
      Object.assign(span.style, { display: 'inline-block', padding: '3px 6px', borderRadius: '4px',
        background, color: '#18212f', fontWeight: '650', fontVariantNumeric: 'tabular-nums', lineHeight: '1.3' });
      return span;
    };
    node.replaceChildren(pill(`${data?.approximate ? '≈ ' : ''}${tempo(data)}`, '#eef2f6'),
      document.createTextNode(' '), pill(`${data?.key || '—'}${data?.uncertain ? ' ?' : ''}`, colors[data?.key] || '#dce3eb'));
    node.setAttribute('aria-label', `Темп: ${tempo(data)}. Тональность: ${data?.key || 'нет данных'}${data?.approximate ? '. Приблизительный анализ' : ''}${data?.uncertain ? '. Требует проверки' : ''}`);
  }
  const presentation = { colors, label, render, onKeyDown: null };
  globalThis.YM_DJ_PRESENTATION = presentation;

  // Register before page scripts: stopping only bubble events cannot block capture-phase shortcuts.
  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, event => {
    const host = document.getElementById('ym-dj-modal');
    if (!host || !event.composedPath().includes(host) && document.activeElement !== host) return;
    event.stopImmediatePropagation();
    // Do not cancel normal editing, composition or the form's native Enter action.
    if (type === 'keydown') presentation.onKeyDown?.(event);
  }, { capture: true });
})();
