import { randomToken } from "./crypto.js";
export const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function page(
  title: string,
  body: string,
  script = "",
  callbackOrigin?: string,
) {
  const nonce = randomToken();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · ExcaliDash</title><style nonce="${nonce}">
  :root{font-family:system-ui,sans-serif;color:#20243c;background:#f5f5fb;color-scheme:light}body{margin:0;padding:48px 20px}main{max-width:620px;margin:auto;background:white;padding:32px;border:1px solid #dcdceb;border-radius:18px;box-shadow:0 8px 30px #23235a09}h1{font-size:28px;margin:8px 0 24px}h2{font-size:19px}p,li{line-height:1.6}small{color:#5e647b}button,.button{display:inline-block;border:0;padding:13px 20px;background:#5046df;color:white;border-radius:9px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;margin:8px 8px 8px 0}button.secondary{background:#ececf5;color:#303348}.account,.connection{padding:16px;background:#f6f6fc;border-radius:10px;overflow-wrap:anywhere;margin:16px 0}.danger{color:#a72e42}code{overflow-wrap:anywhere}a{color:#443bc1}footer{margin-top:24px;font-size:13px;color:#6d7186}
  </style></head><body><main><small>EXCALIDASH · MCP</small><h1>${escape(title)}</h1>${body}<footer>Access is limited to the account and permissions you approve.</footer></main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  return {
    html,
    csp: `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'${callbackOrigin ? " " + callbackOrigin : ""}; frame-ancestors 'none'; base-uri 'none'`,
  };
}
export const loginBody = `<p>Sign in to ExcaliDash in a new tab, then return here to continue. Your password stays with ExcaliDash.</p><a class="button" href="/login" target="_blank" rel="noopener noreferrer">Sign in to ExcaliDash</a><p><button id="continue" type="button">Continue</button></p><small>This page will detect your sign-in automatically.</small>`;
export const loginScript = `document.getElementById('continue').addEventListener('click',()=>location.reload());let checks=0;const timer=setInterval(async()=>{if(++checks>200){clearInterval(timer);return;}try{const r=await fetch('/mcp/oauth/session',{cache:'no-store'});if(r.ok&&(await r.json()).authenticated)location.reload();}catch{}},3000);`;
