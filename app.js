// ============================================================
// SUPABASE
// ============================================================
const SUPA_URL = 'https://gtsiamlpldvvapboeaxi.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0c2lhbWxwbGR2dmFwYm9lYXhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMzE3NDEsImV4cCI6MjA5MDYwNzc0MX0.aUsp60M0dHb4g96yuYVUHOf9bDCjOjj9rUihOKvA5i4';
const { createClient } = supabase;
const sb = createClient(SUPA_URL, SUPA_KEY);

// ============================================================
// ESTADO GLOBAL
// ============================================================
let user      = null;
let itens     = [];       // produtos na receita atual
let estCache  = [];       // cache do estoque
let filtroMov = 'TODOS';
let authMode  = 'login';
let deferredPrompt = null; // PWA install prompt

// ============================================================
// PWA — SERVICE WORKER + INSTALL
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(r => console.log('SW registrado:', r.scope))
      .catch(e => console.log('SW erro:', e));
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('install-banner').style.display = 'flex';
});

window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').style.display = 'none';
  deferredPrompt = null;
});

function instalarPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    deferredPrompt = null;
    document.getElementById('install-banner').style.display = 'none';
  });
}

function fecharBanner() {
  document.getElementById('install-banner').style.display = 'none';
}

// ============================================================
// ONLINE / OFFLINE
// ============================================================
window.addEventListener('online',  () => {
  document.getElementById('offline-bar').style.display = 'none';
  document.getElementById('sync-txt').textContent = ' online';
  if (user) carregarTudo();
});
window.addEventListener('offline', () => {
  document.getElementById('offline-bar').style.display = 'block';
  document.getElementById('sync-txt').textContent = ' offline';
});

// ============================================================
// AUTH
// ============================================================
function switchTab(m) {
  authMode = m;
  document.querySelectorAll('.auth-tab').forEach((t, i) =>
    t.classList.toggle('active', (i===0&&m==='login') || (i===1&&m==='signup'))
  );
  document.getElementById('btnAuth').textContent = m === 'login' ? 'ENTRAR' : 'CADASTRAR';
  document.getElementById('f-nome').classList.toggle('hidden', m === 'login');
  document.getElementById('auth-msg').innerHTML = '';
}

async function handleAuth() {
  const email = document.getElementById('aEmail').value.trim();
  const senha = document.getElementById('aSenha').value;
  const nome  = document.getElementById('aNome').value.trim();
  const btn   = document.getElementById('btnAuth');
  if (!email || !senha) return showMsg('Preencha e-mail e senha.', 'err');
  btn.disabled = true;
  btn.textContent = authMode === 'login' ? 'Entrando...' : 'Cadastrando...';
  try {
    let r;
    if (authMode === 'login') {
      r = await sb.auth.signInWithPassword({ email, password: senha });
    } else {
      r = await sb.auth.signUp({ email, password: senha, options: { data: { nome } } });
    }
    if (r.error) {
      showMsg(tErr(r.error.message), 'err');
    } else if (authMode === 'signup' && !r.data.session) {
      showMsg(' Confirme seu e-mail para entrar!', 'ok');
    } else {
      user = r.data.user;
      entrar();
    }
  } catch(e) {
    showMsg('Sem conexão com a internet.', 'err');
  }
  btn.disabled = false;
  btn.textContent = authMode === 'login' ? 'ENTRAR' : 'CADASTRAR';
}

function tErr(m) {
  if (m.includes('Invalid login'))      return 'E-mail ou senha incorretos.';
  if (m.includes('already registered')) return 'E-mail já cadastrado.';
  if (m.includes('Password should'))    return 'Senha deve ter 6+ caracteres.';
  return m;
}

function showMsg(t, c) {
  document.getElementById('auth-msg').innerHTML = `<div class="auth-msg ${c}">${t}</div>`;
}

async function logout() {
  await sb.auth.signOut();
  user = null; itens = []; estCache = [];
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

function entrar() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('chip-user').textContent = user.email.split('@')[0];
  carregarTudo();
}

// Checar sessão ao abrir
sb.auth.getSession().then(({ data: { session } }) => {
  if (session) { user = session.user; entrar(); }
});

// Enter no login
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('auth-screen').style.display !== 'none') handleAuth();
});

// ============================================================
// ABAS
// ============================================================
function mudar(aba) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('ativa-rec','ativa-est','ativa-mov'));
  document.getElementById('v-' + aba).classList.add('active-view');
  const cls = aba==='rec' ? 'ativa-rec' : aba==='est' ? 'ativa-est' : 'ativa-mov';
  document.getElementById('tab-' + aba).classList.add(cls);
  if (aba === 'est') renderSaldos();
  if (aba === 'mov') renderMovs();
}

// ============================================================
// SYNC INDICATOR
// ============================================================
function sync(on) {
  document.getElementById('sync-txt').textContent = on ? ' sync' : ' online';
}

// ============================================================
// CARREGAR TUDO
// ============================================================
async function carregarTudo() {
  await Promise.all([carregarEstoque(), carregarOS()]);
  atualizarSug();
}

// ============================================================
// ESTOQUE — CACHE
// ============================================================
async function carregarEstoque() {
  if (!user) return;
  const { data } = await sb.from('estoque').select('*').eq('user_id', user.id).order('nome');
  estCache = data || [];
  atualizarSug();
}

function atualizarSug() {
  const dl = document.getElementById('sug');
  dl.innerHTML = '';
  estCache.forEach(e => {
    const o = document.createElement('option');
    o.value = e.nome;
    dl.appendChild(o);
  });
}

function checarEstoque() {
  const nome = document.getElementById('pNom').value.trim().toUpperCase();
  const p    = estCache.find(e => e.nome.toUpperCase() === nome);
  const div  = document.getElementById('info-est-prod');
  if (p) {
    div.innerHTML = `<span style="color:#2e7d32;font-weight:700"> Em estoque: ${(p.qtd||0).toFixed(2)} ${p.unid||''}</span>`;
  } else if (nome.length > 1) {
    div.innerHTML = `<span class="alerta-sem-est"> Fora do estoque — será adicionado mesmo assim</span>`;
  } else {
    div.innerHTML = '';
  }
}

// ============================================================
// RECEITA — CÁLCULO
// ============================================================
function calc() {
  const h = parseFloat(document.getElementById('ha').value) || 0;
  const t = parseFloat(document.getElementById('tq').value) || 1;
  const v = parseFloat(document.getElementById('vz').value) || 1;
  const total = h * v;
  const nTq   = Math.ceil(total / t);
  const resto = total % t;
  document.getElementById('res-calda').innerText  = total.toLocaleString('pt-BR') + ' L';
  document.getElementById('res-tanque').innerText = nTq;
  document.getElementById('res-resto').innerText  = (resto === 0 ? t : resto).toLocaleString('pt-BR') + ' L';
  renderItens();
}

function addP() {
  const n = document.getElementById('pNom').value.trim().toUpperCase();
  const d = parseFloat(document.getElementById('pDos').value);
  if (!n || isNaN(d)) return;
  const noEst = estCache.find(e => e.nome.toUpperCase() === n);
  itens.push({ n, d, u: document.getElementById('pUni').value, noEstoque: !!noEst });
  document.getElementById('pNom').value  = '';
  document.getElementById('pDos').value  = '';
  document.getElementById('info-est-prod').innerHTML = '';
  calc();
}

function renderItens() {
  const tb = document.getElementById('lista-p');
  const t  = parseFloat(document.getElementById('tq').value) || 2000;
  const v  = parseFloat(document.getElementById('vz').value) || 100;
  const h  = parseFloat(document.getElementById('ha').value) || 0;
  tb.innerHTML = '';
  itens.forEach((p, i) => {
    const cor = p.noEstoque ? 'color:#1b5e20' : 'color:#c62828';
    const tag = p.noEstoque
      ? '<span style="font-size:9px;background:#e8f5e9;color:#2e7d32;padding:1px 5px;border-radius:8px;font-weight:700">EST</span>'
      : '<span style="font-size:9px;background:#ffebee;color:#c62828;padding:1px 5px;border-radius:8px;font-weight:700">S/EST</span>';
    tb.innerHTML += `<tr>
      <td><b style="${cor}">${p.n}</b> ${tag}</td>
      <td>${((p.d*t)/v).toFixed(2)}<small>/Tq</small></td>
      <td>${(p.d*h).toFixed(2)}<small> tot</small></td>
      <td><button class="btn-del" onclick="itens.splice(${i},1);calc()"></button></td>
    </tr>`;
  });
}

// ============================================================
// SALVAR OS + BAIXAR ESTOQUE
// ============================================================
async function salvarR() {
  const f = document.getElementById('faz').value.trim().toUpperCase();
  const h = parseFloat(document.getElementById('ha').value);
  if (!f || !h || itens.length === 0) return alert('Preencha Fazenda, Área e adicione produtos!');
  if (!user) return;

  const btn = document.getElementById('btnSalvarOS');
  btn.disabled = true; btn.textContent = ' Salvando...'; sync(true);

  const t   = parseFloat(document.getElementById('tq').value) || 2000;
  const v   = parseFloat(document.getElementById('vz').value) || 100;
  const obs = document.getElementById('obs_r').value;

  try {
    // 1. Salvar OS
    const { error: eOS } = await sb.from('receituarios').insert({
      user_id: user.id,
      fazenda: f, area: h, tanque: t, calda: v, obs,
      data_aplicacao: new Date().toISOString().split('T')[0],
      produtos: itens
    });
    if (eOS) throw eOS;

    // 2. Baixar estoque dos produtos cadastrados
    let baixas = [];
    for (const p of itens) {
      const idx = estCache.findIndex(e => e.nome.toUpperCase() === p.n.toUpperCase());
      if (idx > -1) {
        const consumo  = p.d * h;
        const novaQtd  = Math.max(0, estCache[idx].qtd - consumo);
        await sb.from('estoque').update({ qtd: novaQtd }).eq('id', estCache[idx].id).eq('user_id', user.id);
        await sb.from('movimentacoes').insert({
          user_id: user.id,
          tipo: 'SAIDA',
          nome: p.n,
          qtd: consumo,
          unid: p.u.replace('/ha', ''),
          destino: 'CAMPO: ' + f,
          saldo_apos: novaQtd
        });
        baixas.push({ nome: p.n, antes: estCache[idx].qtd.toFixed(2), depois: novaQtd.toFixed(2), unid: p.u.replace('/ha','') });
      }
    }

    await carregarEstoque();
    await carregarOS();

    // 3. Gerar PDF
    gerarPDF_OS({ faz: f, ha: h, t, v, obs, itens: [...itens] });

    const resumo = baixas.length > 0
      ? '\n\nEstoque baixado:\n' + baixas.map(b => `• ${b.nome}: ${b.antes}  ${b.depois} ${b.unid}`).join('\n')
      : '\n\n(Produtos fora do estoque não foram baixados)';
    alert(' OS Gerada e salva na nuvem!' + resumo);

    // Limpar
    itens = [];
    document.getElementById('faz').value = '';
    document.getElementById('ha').value  = '';
    calc();

  } catch(e) { alert('Erro ao salvar: ' + e.message); }

  btn.disabled = false;
  btn.textContent = ' GERAR OS E BAIXAR ESTOQUE';
  sync(false);
}

// ============================================================
// OS SALVAS
// ============================================================
async function carregarOS() {
  if (!user) return;
  const { data } = await sb.from('receituarios').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30);
  const div = document.getElementById('lista-os');
  if (!data || data.length === 0) {
    div.innerHTML = '<p style="padding:16px;color:#888;font-size:13px;text-align:center">Nenhuma OS salva.</p>';
    return;
  }
  div.innerHTML = data.map(r => `
    <div class="item-lista" style="border-left-color:var(--verde)">
      <span>
        <b>${r.fazenda}</b><br>
        <small>${r.area} ha · ${r.produtos.length} produtos · ${new Date(r.created_at).toLocaleDateString('pt-BR')}</small>
      </span>
      <div style="display:flex;gap:4px">
        <button style="background:var(--verde);color:white;border:none;padding:6px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer"
          onclick='recarregarOS(${JSON.stringify(r).replace(/'/g,"&#39;")})'></button>
        <button class="btn-del" onclick="excluirOS('${r.id}')"></button>
      </div>
    </div>`).join('');
}

function recarregarOS(r) {
  if (typeof r === 'string') r = JSON.parse(r);
  document.getElementById('faz').value  = r.fazenda;
  document.getElementById('ha').value   = r.area;
  document.getElementById('tq').value   = r.tanque;
  document.getElementById('vz').value   = r.calda;
  document.getElementById('obs_r').value = r.obs || '';
  itens = [...r.produtos];
  calc();
  mudar('rec');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function excluirOS(id) {
  if (!confirm('Excluir esta OS?')) return;
  sync(true);
  await sb.from('receituarios').delete().eq('id', id).eq('user_id', user.id);
  await carregarOS();
  sync(false);
}

// ============================================================
// ESTOQUE — LANÇAR
// ============================================================
function ajustarMotivo() {
  const t = document.getElementById('eTip').value;
  document.getElementById('div-des').style.display = (t === 'ENTRADA') ? 'none' : 'block';
  document.getElementById('lbl-motivo').textContent = t === 'EMPRESTIMO' ? 'Destino / Pessoa' : 'Motivo / Destino';
}

async function regEstoque() {
  const n   = document.getElementById('eNom').value.trim().toUpperCase();
  const q   = parseFloat(document.getElementById('eQtd').value);
  const t   = document.getElementById('eTip').value;
  const u   = document.getElementById('eUni').value;
  const des = document.getElementById('eDes').value.trim().toUpperCase() || 'GERAL';
  if (!n || isNaN(q) || q <= 0) return alert('Preencha Nome e Quantidade!');

  const btn = document.getElementById('btnRegEstoque');
  btn.disabled = true; btn.textContent = ' Salvando...'; sync(true);

  try {
    const idx  = estCache.findIndex(e => e.nome.toUpperCase() === n);
    const mult = (t === 'ENTRADA') ? 1 : -1;

    if (idx > -1) {
      const nova = Math.max(0, estCache[idx].qtd + (q * mult));
      await sb.from('estoque').update({ qtd: nova, unid: u }).eq('id', estCache[idx].id).eq('user_id', user.id);
      await sb.from('movimentacoes').insert({ user_id: user.id, tipo: t, nome: n, qtd: q, unid: u, destino: des, saldo_apos: nova });
    } else {
      const novaQtd = (t === 'ENTRADA') ? q : 0;
      await sb.from('estoque').insert({ user_id: user.id, nome: n, qtd: novaQtd, unid: u });
      await sb.from('movimentacoes').insert({ user_id: user.id, tipo: t, nome: n, qtd: q, unid: u, destino: des, saldo_apos: novaQtd });
    }

    await carregarEstoque();
    renderSaldos();
    alert(' Estoque atualizado!');
    document.getElementById('eNom').value = '';
    document.getElementById('eQtd').value = '';
    document.getElementById('eDes').value = '';

  } catch(e) { alert('Erro: ' + e.message); }

  btn.disabled = false;
  btn.textContent = ' SALVAR NO ESTOQUE';
  sync(false);
}

// ============================================================
// SALDOS
// ============================================================
async function renderSaldos() {
  await carregarEstoque();
  const div = document.getElementById('saldos-e');
  if (estCache.length === 0) {
    div.innerHTML = '<center style="padding:18px;color:#999">Estoque Vazio</center>';
    return;
  }
  div.innerHTML = estCache.map(e => `
    <div class="item-lista">
      <span><b>${e.nome}</b><br><small>${(e.qtd||0).toFixed(2)} ${e.unid||''}</small></span>
      <button class="btn-del" onclick="excluirProduto('${e.id}')"></button>
    </div>`).join('');
}

async function excluirProduto(id) {
  if (!confirm('Excluir este produto do estoque?')) return;
  sync(true);
  await sb.from('estoque').delete().eq('id', id).eq('user_id', user.id);
  await carregarEstoque();
  renderSaldos();
  sync(false);
}

// ============================================================
// MOVIMENTAÇÕES
// ============================================================
function setFiltro(f, btn) {
  filtroMov = f;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderMovs();
}

async function renderMovs() {
  if (!user) return;
  let q = sb.from('movimentacoes').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(200);
  if (filtroMov !== 'TODOS') q = q.eq('tipo', filtroMov);
  const { data } = await q;
  const div = document.getElementById('lista-movs');
  if (!data || data.length === 0) {
    div.innerHTML = '<p style="padding:16px;color:#888;font-size:13px;text-align:center">Nenhuma movimentação.</p>';
    return;
  }
  div.innerHTML = data.map(m => {
    const cls      = m.tipo==='ENTRADA' ? 'mov-entrada' : m.tipo==='SAIDA' ? 'mov-saida' : 'mov-emprestimo';
    const badgeCls = m.tipo==='ENTRADA' ? 'badge-entrada' : m.tipo==='SAIDA' ? 'badge-saida' : 'badge-emprestimo';
    const sinal    = m.tipo==='ENTRADA' ? '+' : '-';
    return `<div class="mov-item ${cls}">
      <span class="badge ${badgeCls}">${m.tipo}</span>
      <b style="margin-left:6px">${m.nome}</b>
      <span style="float:right;font-weight:700;color:${m.tipo==='ENTRADA'?'#2e7d32':'#c62828'}">${sinal}${(m.qtd||0).toFixed(2)} ${m.unid||''}</span>
      <div class="mov-meta">${m.destino||''} · ${new Date(m.created_at).toLocaleString('pt-BR')}${m.saldo_apos!=null?' · Saldo: '+m.saldo_apos.toFixed(2):''}</div>
    </div>`;
  }).join('');
}

// ============================================================
// PDF — OS
// ============================================================
function gerarPDF_OS(d) {
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFillColor(27, 94, 32); doc.rect(0, 0, 210, 28, 'F');
    doc.setTextColor(255); doc.setFontSize(16);
    doc.text('ORDEM DE PULVERIZAÇÃO', 105, 14, { align: 'center' });
    doc.setFontSize(9);
    doc.text(`${d.faz}  |  ${d.ha} ha  |  ${new Date().toLocaleString('pt-BR')}`, 105, 22, { align: 'center' });
    doc.setTextColor(40);
    const corpo = d.itens.map(p => [
      p.n + (p.noEstoque ? '' : '  S/EST'),
      p.d + ' ' + p.u,
      ((p.d * d.t) / d.v).toFixed(2),
      (p.d * d.ha).toFixed(2)
    ]);
    doc.autoTable({ startY: 33, head: [['PRODUTO','DOSE/HA','POR TANQUE','TOTAL']], body: corpo, headStyles: { fillColor: [27,94,32] }, theme: 'grid' });
    if (d.obs) doc.text('OBS: ' + d.obs, 15, doc.lastAutoTable.finalY + 8);
    doc.save(`OS_${d.faz.replace(/\s/g,'_')}.pdf`);
  } catch(e) { alert('Erro PDF: ' + e.message); }
}

// ============================================================
// PDF — RELATÓRIOS
// ============================================================
async function relatorio(f) {
  if (!user) return;
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let tit = ''; let cor = [0,0,0];
    if (f==='INVENTARIO') { tit = 'ESTOQUE ATUAL — INVENTÁRIO'; cor = [27,94,32]; }
    else if (f==='SAIDA')      { tit = 'RELATÓRIO DE SAÍDAS';      cor = [13,71,161]; }
    else if (f==='EMPRESTIMO') { tit = 'RELATÓRIO DE EMPRÉSTIMOS'; cor = [230,81,0]; }
    doc.setFillColor(...cor); doc.rect(0, 0, 210, 20, 'F');
    doc.setTextColor(255); doc.setFontSize(13);
    doc.text(tit, 105, 13, { align: 'center' });
    let head, body;
    if (f === 'INVENTARIO') {
      head = [['PRODUTO','SALDO','UNIDADE']];
      body = estCache.filter(e => e.qtd > 0).map(e => [e.nome, (e.qtd||0).toFixed(2), e.unid||'']);
    } else {
      const { data } = await sb.from('movimentacoes').select('*').eq('user_id', user.id).eq('tipo', f).order('created_at', { ascending: false });
      head = [['DATA','PRODUTO','QTD','DESTINO']];
      body = (data||[]).map(m => [
        new Date(m.created_at).toLocaleDateString('pt-BR'),
        m.nome,
        (m.qtd||0).toFixed(2) + ' ' + (m.unid||''),
        m.destino||''
      ]);
    }
    if (body.length === 0) { alert('Nenhum dado para este relatório.'); return; }
    doc.autoTable({ startY: 24, head, body, headStyles: { fillColor: cor }, theme: 'grid' });
    doc.save(`Relatorio_${f}.pdf`);
  } catch(e) { alert('Erro: ' + e.message); }
}
