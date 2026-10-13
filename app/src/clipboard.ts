/** Copy text to the clipboard; resolves false when the browser refuses (e.g. insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through to the legacy path */ }
  try {
    const el = document.createElement('textarea');
    el.value = text; el.setAttribute('readonly', ''); el.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(el); el.select();
    const ok = document.execCommand('copy'); document.body.removeChild(el); return ok;
  } catch { return false; }
}
