/*
 * ═══════════════════════════════════════════════════════
 *  NOVICASAS — Servidor de Cobros Automáticos por WhatsApp
 *  Usando: Twilio WhatsApp Sandbox
 * ═══════════════════════════════════════════════════════
 *
 *  PARA EJECUTAR:
 *    1. Instala Node.js: https://nodejs.org (descarga e instala)
 *    2. Abre una terminal/CMD en la carpeta de este archivo
 *    3. Ejecuta: npm install
 *    4. Ejecuta: node server.js
 *    5. El servidor arranca en http://localhost:3000
 *
 *  PARA DESPLEGAR EN LA NUBE (gratis):
 *    1. Sube estos archivos a GitHub
 *    2. Ve a https://railway.app → New Project → Deploy from GitHub
 *    3. Se despliega automáticamente y corre 24/7
 *
 * ═══════════════════════════════════════════════════════
 */

const express = require('express');
const cron = require('node-cron');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ═══ TUS CREDENCIALES TWILIO ═══
const ACCOUNT_SID = process.env.TWILIO_SID || 'AC17e18ff3847ed384ceb89f5cfac0bc20';
const AUTH_TOKEN = process.env.TWILIO_TOKEN || '72be396213cac707abf745adab5259fd';
const TWILIO_WA = 'whatsapp:+14155238886'; // Número Sandbox de Twilio

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

// ═══ CONFIGURACIÓN ═══
const CONFIG = {
  HORA_RECORDATORIO: '08:00', // Recordatorios 1 día antes
  HORA_COBRO: '09:00',       // Cobros del día
  HORA_MORA: '10:00',        // Avisos de mora
  PROPIETARIOS: {
    CEL: { nombre: 'CELAQUE S.R.L.', banco: 'BANCO NACIONAL DE BOLIVIA', cuenta: '2000170755' },
    A: { nombre: 'Alvaro Heredia Novillo', banco: 'BANCO ECONOMICO S.A.', cuenta: '2081318318' },
    D: { nombre: 'David Heredia Novillo', banco: 'BANCO ECONOMICO S.A.', cuenta: '1061318313' }
  },
  PORT: process.env.PORT || 3000
};

// ═══ BASE DE DATOS (archivo JSON) ═══
const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { console.error('Error DB:', e); }
  return { ventas: [], clientes: [], lotes: [], logEnvios: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ═══ ENVIAR WHATSAPP POR TWILIO ═══
async function enviarWA(telefono, mensaje) {
  try {
    let tel = telefono.replace(/\D/g, '');
    if (!tel.startsWith('591')) tel = '591' + tel;

    const msg = await client.messages.create({
      body: mensaje,
      from: TWILIO_WA,
      to: 'whatsapp:+' + tel
    });

    console.log('✅ WhatsApp enviado a +' + tel + ' (SID: ' + msg.sid + ')');
    return { ok: true, sid: msg.sid };
  } catch (error) {
    console.error('❌ Error WA a ' + telefono + ':', error.message);
    return { ok: false, error: error.message };
  }
}

// ═══ FUNCIONES DE FECHA ═══
function hoy() { return new Date().toISOString().split('T')[0]; }
function manana() { var d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function fmtFecha(f) { return new Date(f + 'T12:00:00').toLocaleDateString('es-BO'); }

// ═══ ANALIZAR PAGOS PENDIENTES ═══
function analizarPagos(db) {
  var hoyStr = hoy(), manStr = manana();
  var result = { recordatorios: [], cobrosHoy: [], enMora: [] };

  (db.ventas || []).forEach(function (vta) {
    if (!vta.cronograma || !vta.plan || vta.plan <= 0) return;
    var cli = (db.clientes || []).find(function (c) { return c.id == vta.cliId; });
    var lot = (db.lotes || []).find(function (l) { return String(l.id) === String(vta.lotId); });
    if (!cli || !lot) return;

    vta.cronograma.forEach(function (cuota) {
      if (cuota.pagado) return;
      var obj = { vta: vta, cli: cli, lot: lot, cuota: cuota };

      if (cuota.fecha === manStr) result.recordatorios.push(obj);
      else if (cuota.fecha === hoyStr) result.cobrosHoy.push(obj);
      else if (cuota.fecha < hoyStr) result.enMora.push(obj);
    });
  });

  return result;
}

// ═══ GENERAR MENSAJES ═══
function generarMsg(tipo, cli, lot, cuota, vta) {
  var prop = CONFIG.PROPIETARIOS[lot.propietario || 'D'] || CONFIG.PROPIETARIOS.D;
  var banco = '🏦 ' + prop.banco + '\n💳 Cuenta: *' + prop.cuenta + '*\n👤 A nombre de: *' + prop.nombre + '*';
  var lotInfo = '*' + lot.codigo + '* (CDA MZ' + lot.mz + ' LT' + lot.lt + ')';
  var fecha = fmtFecha(cuota.fecha);
  var ref = 'NVC-' + vta.id + '-C' + cuota.num;

  if (tipo === 'recordatorio') {
    return 'Estimado/a *' + cli.nom + ' ' + cli.ape + '*, le saluda *NOVICASAS* 🏠.\n\n' +
      '⏰ *RECORDATORIO:* Mañana *' + fecha + '* vence su cuota #' + cuota.num +
      ' de *$' + fmt(cuota.monto) + ' USD* del lote ' + lotInfo + '.\n\n' +
      '📌 Deposite a:\n' + banco + '\n\n' +
      '📝 Ref: *' + ref + '*\n\n' +
      '📸 Envíe su comprobante como *foto* a este chat y se registra al instante.\n\n' +
      '¡Gracias! *NOVICASAS* 🏠';
  }

  if (tipo === 'cobro') {
    return 'Estimado/a *' + cli.nom + ' ' + cli.ape + '*, le saluda *NOVICASAS* 🏠.\n\n' +
      '📅 *HOY vence* su cuota #' + cuota.num + ' de *$' + fmt(cuota.monto) + ' USD* del lote ' + lotInfo + '.\n\n' +
      '💰 Pague a:\n' + banco + '\n\n' +
      '📝 Ref: *' + ref + '*\n\n' +
      '📸 *Envíe foto del comprobante* y su pago se registra automáticamente.\n\n' +
      'Gracias. *NOVICASAS* 🏠';
  }

  if (tipo === 'mora') {
    var dias = Math.floor((new Date() - new Date(cuota.fecha + 'T12:00:00')) / 86400000);
    return 'Estimado/a *' + cli.nom + ' ' + cli.ape + '*,\n\n' +
      '⚠️ *AVISO DE MORA — NOVICASAS* 🏠\n\n' +
      'Su cuota #' + cuota.num + ' de *$' + fmt(cuota.monto) + ' USD* del lote ' + lotInfo +
      ' venció el *' + fecha + '* (hace ' + dias + ' días).\n\n' +
      '💰 Pague a:\n' + banco + '\n\n' +
      '📝 Ref: *' + ref + '*\n📸 Envíe comprobante a este chat.\n\n*NOVICASAS* 🏠';
  }

  if (tipo === 'confirmacion') {
    return '✅ *PAGO REGISTRADO — NOVICASAS* 🏠\n\n' +
      'Estimado/a *' + cli.nom + ' ' + cli.ape + '*, confirmamos su pago:\n\n' +
      '📌 Cuota #' + cuota.num + '\n💰 Monto: *$' + fmt(cuota.monto) + ' USD*\n' +
      '📍 Lote: ' + lotInfo + '\n📅 Fecha: ' + new Date().toLocaleDateString('es-BO') + '\n\n' +
      'Su cuota fue marcada como *PAGADA* ✅\n\n¡Gracias! *NOVICASAS* 🏠';
  }

  return '';
}

// ═══ TAREAS AUTOMÁTICAS (CRON) ═══

// 8:00 AM — Recordatorios (cuotas de mañana)
cron.schedule('0 8 * * *', async function () {
  console.log('\n⏰ [AUTO] Enviando RECORDATORIOS...');
  var db = loadDB();
  var items = analizarPagos(db).recordatorios;

  for (var item of items) {
    var msg = generarMsg('recordatorio', item.cli, item.lot, item.cuota, item.vta);
    var r = await enviarWA(item.cli.tel, msg);
    db.logEnvios.push({ fecha: new Date().toISOString(), tipo: 'recordatorio', cliente: item.cli.nom + ' ' + item.cli.ape, cuota: item.cuota.num, resultado: r.ok ? 'enviado' : 'error' });
    await new Promise(function (resolve) { setTimeout(resolve, 2000); });
  }

  saveDB(db);
  console.log('✅ ' + items.length + ' recordatorios procesados');
});

// 9:00 AM — Cobros del día
cron.schedule('0 9 * * *', async function () {
  console.log('\n📱 [AUTO] Enviando COBROS DEL DÍA...');
  var db = loadDB();
  var items = analizarPagos(db).cobrosHoy;

  for (var item of items) {
    var msg = generarMsg('cobro', item.cli, item.lot, item.cuota, item.vta);
    var r = await enviarWA(item.cli.tel, msg);
    db.logEnvios.push({ fecha: new Date().toISOString(), tipo: 'cobro', cliente: item.cli.nom + ' ' + item.cli.ape, cuota: item.cuota.num, monto: item.cuota.monto, resultado: r.ok ? 'enviado' : 'error' });
    await new Promise(function (resolve) { setTimeout(resolve, 2000); });
  }

  saveDB(db);
  console.log('✅ ' + items.length + ' cobros procesados');
});

// 10:00 AM — Avisos de mora
cron.schedule('0 10 * * *', async function () {
  console.log('\n🚨 [AUTO] Enviando AVISOS DE MORA...');
  var db = loadDB();
  var items = analizarPagos(db).enMora;

  // Agrupar por cliente
  var porCli = {};
  items.forEach(function (item) {
    var cid = item.cli.id;
    if (!porCli[cid]) porCli[cid] = { cli: item.cli, lot: item.lot, vta: item.vta, cuotas: [] };
    porCli[cid].cuotas.push(item.cuota);
  });

  for (var grupo of Object.values(porCli)) {
    var msg = generarMsg('mora', grupo.cli, grupo.lot, grupo.cuotas[0], grupo.vta);
    await enviarWA(grupo.cli.tel, msg);
    await new Promise(function (resolve) { setTimeout(resolve, 2000); });
  }

  saveDB(db);
  console.log('✅ ' + Object.keys(porCli).length + ' avisos de mora procesados');
});

// ═══ WEBHOOK — RECIBIR MENSAJES DE CLIENTES ═══
app.post('/webhook', async function (req, res) {
  try {
    var from = (req.body.From || '').replace('whatsapp:', '').replace('+', '');
    var body = (req.body.Body || '').trim();
    var numMedia = parseInt(req.body.NumMedia || '0');
    var mediaUrl = req.body.MediaUrl0 || '';

    console.log('\n📩 Mensaje de +' + from + ': ' + (numMedia > 0 ? '[IMAGEN]' : body));

    var db = loadDB();

    // Buscar cliente por teléfono
    var cliente = db.clientes.find(function (c) {
      var tel = (c.tel || '').replace(/\D/g, '');
      return from.endsWith(tel) || tel.endsWith(from.slice(-8));
    });

    if (!cliente) {
      await enviarWA(from, 'Hola! Este es el sistema automático de *NOVICASAS* 🏠.\n\nNo encontramos su número en nuestro sistema. Contacte a: +591 708714251');
      return res.status(200).send('OK');
    }

    // Si envía IMAGEN → es un comprobante de pago
    if (numMedia > 0) {
      console.log('📸 Comprobante recibido de: ' + cliente.nom + ' ' + cliente.ape);

      var venta = db.ventas.find(function (v) { return v.cliId == cliente.id && parseInt(v.plan) > 0; });
      if (!venta || !venta.cronograma) {
        await enviarWA(from, 'Hola *' + cliente.nom + '*, no encontramos cuotas pendientes. Contacte a nuestro equipo si es un error.');
        return res.status(200).send('OK');
      }

      var cuotaPend = venta.cronograma.find(function (c) { return !c.pagado; });
      if (!cuotaPend) {
        await enviarWA(from, 'Hola *' + cliente.nom + '*, todas sus cuotas están al día. ¡Felicidades! 🎉');
        return res.status(200).send('OK');
      }

      // ✅ MARCAR COMO PAGADO AUTOMÁTICAMENTE
      cuotaPend.pagado = true;
      cuotaPend.fechaPago = hoy();
      cuotaPend.metodo = 'WhatsApp Auto';
      cuotaPend.ref = 'Comprobante WA - ' + new Date().toLocaleString('es-BO');
      if (mediaUrl) cuotaPend.comprobanteUrl = mediaUrl;

      var lot = db.lotes.find(function (l) { return String(l.id) === String(venta.lotId); });

      // Enviar confirmación
      var confirmMsg = generarMsg('confirmacion', cliente, lot || {}, cuotaPend, venta);
      await enviarWA(from, confirmMsg);

      db.logEnvios.push({
        fecha: new Date().toISOString(),
        tipo: 'pago_auto',
        cliente: cliente.nom + ' ' + cliente.ape,
        cuota: cuotaPend.num,
        monto: cuotaPend.monto,
        resultado: 'pagado_auto'
      });

      saveDB(db);
      console.log('✅ PAGO AUTO: Cuota #' + cuotaPend.num + ' de ' + cliente.nom + ' → PAGADA');

    } else {
      // Mensaje de texto — responder con estado de cuenta
      var textoL = body.toLowerCase();
      var venta = db.ventas.find(function (v) { return v.cliId == cliente.id && parseInt(v.plan) > 0; });

      if (textoL.includes('estado') || textoL.includes('cuota') || textoL.includes('pago') || textoL.includes('saldo') || textoL.includes('hola')) {
        if (venta && venta.cronograma) {
          var pagadas = venta.cronograma.filter(function (c) { return c.pagado; }).length;
          var total = venta.cronograma.length;
          var prox = venta.cronograma.find(function (c) { return !c.pagado; });
          var lot = db.lotes.find(function (l) { return String(l.id) === String(venta.lotId); });

          var resp = 'Hola *' + cliente.nom + '* 🏠\n\n📊 *Estado de su cuenta:*\n\n' +
            '📍 Lote: *' + (lot ? lot.codigo : 'N/A') + '*\n' +
            '✅ Pagadas: *' + pagadas + '/' + total + '*\n' +
            '📊 Progreso: *' + Math.round(pagadas / total * 100) + '%*\n';

          if (prox) {
            resp += '\n📅 Próxima cuota: #' + prox.num + '\n' +
              '💰 Monto: *$' + fmt(prox.monto) + ' USD*\n' +
              '📅 Vence: *' + fmtFecha(prox.fecha) + '*\n';
          } else {
            resp += '\n🎉 *¡Todas las cuotas pagadas!*\n';
          }

          resp += '\n📸 Para pagar, envíe *foto del comprobante* a este chat.\n\n*NOVICASAS* 🏠';
          await enviarWA(from, resp);
        }
      } else {
        await enviarWA(from, 'Hola *' + cliente.nom + '* 🏠\n\nSoy el asistente de *NOVICASAS*.\n\n' +
          'Escriba *"estado"* para ver sus cuotas o envíe *foto del comprobante* para registrar su pago.\n\n' +
          'Atención humana: +591 708714251');
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error webhook:', error);
    res.status(200).send('OK');
  }
});

// ═══ API — Sincronizar datos desde el sistema HTML ═══
app.post('/api/sync', function (req, res) {
  var db = loadDB();
  if (req.body.ventas) db.ventas = req.body.ventas;
  if (req.body.clientes) db.clientes = req.body.clientes;
  if (req.body.lotes) db.lotes = req.body.lotes;
  saveDB(db);
  res.json({ ok: true, msg: 'Datos sincronizados', ventas: db.ventas.length, clientes: db.clientes.length, lotes: db.lotes.length });
});

// Estado de pagos
app.get('/api/pagos', function (req, res) {
  var db = loadDB();
  var a = analizarPagos(db);
  res.json({ recordatorios: a.recordatorios.length, cobrosHoy: a.cobrosHoy.length, enMora: a.enMora.length, log: (db.logEnvios || []).slice(-20) });
});

// Enviar mensaje manual
app.post('/api/enviar', async function (req, res) {
  var r = await enviarWA(req.body.telefono, req.body.mensaje);
  res.json(r);
});

// Forzar envío ahora
app.post('/api/forzar/:tipo', async function (req, res) {
  var db = loadDB();
  var a = analizarPagos(db);
  var items = req.params.tipo === 'recordatorios' ? a.recordatorios : req.params.tipo === 'cobros' ? a.cobrosHoy : a.enMora;
  var enviados = 0;

  for (var item of items) {
    var msg = generarMsg(req.params.tipo === 'recordatorios' ? 'recordatorio' : req.params.tipo === 'cobros' ? 'cobro' : 'mora', item.cli, item.lot, item.cuota, item.vta);
    await enviarWA(item.cli.tel, msg);
    enviados++;
    await new Promise(function (r) { setTimeout(r, 2000); });
  }

  res.json({ ok: true, enviados: enviados });
});

// ═══ PANEL WEB ═══
app.get('/', function (req, res) {
  var db = loadDB();
  var a = analizarPagos(db);
  var log = (db.logEnvios || []).slice(-10).reverse();

  res.send('<!DOCTYPE html><html><head><title>NOVICASAS Server</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    'body{font-family:system-ui;background:#0A3622;color:#fff;margin:0;padding:20px}' +
    'h1{text-align:center;font-size:24px;margin-bottom:4px}' +
    '.sub{text-align:center;color:#4ade80;font-size:12px;margin-bottom:24px}' +
    '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px}' +
    '.st{background:rgba(255,255,255,.08);border-radius:12px;padding:16px;text-align:center}' +
    '.st .n{font-size:28px;font-weight:800;color:#f0c040}.st .l{font-size:10px;color:rgba(255,255,255,.5);margin-top:4px}' +
    '.btns{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;justify-content:center}' +
    '.btn{padding:10px 20px;border-radius:8px;border:none;font-weight:700;cursor:pointer;font-size:12px}' +
    '.btn-r{background:#f59e0b;color:#000}.btn-c{background:#25D366;color:#fff}.btn-m{background:#ef4444;color:#fff}.btn-s{background:#3b82f6;color:#fff}' +
    '.log{background:rgba(0,0,0,.2);border-radius:10px;padding:14px;max-height:300px;overflow-y:auto}' +
    '.log-item{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:12px;color:rgba(255,255,255,.7)}' +
    '</style></head><body>' +
    '<h1>🏠 NOVICASAS</h1><div class="sub">Servidor de Cobros WhatsApp — ACTIVO ✅</div>' +
    '<div class="stats">' +
    '<div class="st"><div class="n">' + a.recordatorios.length + '</div><div class="l">Vencen mañana</div></div>' +
    '<div class="st"><div class="n" style="color:#25D366">' + a.cobrosHoy.length + '</div><div class="l">Vencen hoy</div></div>' +
    '<div class="st"><div class="n" style="color:#ef4444">' + a.enMora.length + '</div><div class="l">En mora</div></div>' +
    '<div class="st"><div class="n" style="color:#3b82f6">' + db.ventas.filter(function (v) { return parseInt(v.plan) > 0; }).length + '</div><div class="l">Contratos</div></div>' +
    '</div>' +
    '<div class="btns">' +
    '<button class="btn btn-r" onclick="fetch(\'/api/forzar/recordatorios\',{method:\'POST\'}).then(r=>r.json()).then(d=>alert(d.enviados+\' recordatorios enviados\'))">⏰ Enviar Recordatorios</button>' +
    '<button class="btn btn-c" onclick="fetch(\'/api/forzar/cobros\',{method:\'POST\'}).then(r=>r.json()).then(d=>alert(d.enviados+\' cobros enviados\'))">📱 Enviar Cobros Hoy</button>' +
    '<button class="btn btn-m" onclick="fetch(\'/api/forzar/mora\',{method:\'POST\'}).then(r=>r.json()).then(d=>alert(d.enviados+\' avisos enviados\'))">🚨 Enviar Mora</button>' +
    '<button class="btn btn-s" onclick="location.reload()">🔄 Actualizar</button>' +
    '</div>' +
    '<div style="font-size:11px;color:rgba(255,255,255,.4);text-align:center;margin-bottom:16px">' +
    'Auto: Recordatorios ' + CONFIG.HORA_RECORDATORIO + ' · Cobros ' + CONFIG.HORA_COBRO + ' · Mora ' + CONFIG.HORA_MORA +
    ' · Webhook: /webhook · Última rev: ' + new Date().toLocaleString('es-BO') + '</div>' +
    '<h3 style="font-size:14px;margin-bottom:8px">📋 Últimos envíos</h3>' +
    '<div class="log">' +
    (log.length ? log.map(function (l) {
      var icon = l.tipo === 'pago_auto' ? '✅' : l.tipo === 'recordatorio' ? '⏰' : l.tipo === 'cobro' ? '📱' : '🚨';
      return '<div class="log-item">' + icon + ' ' + l.cliente + ' — Cuota #' + l.cuota + ' — ' + l.resultado + ' — ' + new Date(l.fecha).toLocaleString('es-BO') + '</div>';
    }).join('') : '<div style="text-align:center;color:rgba(255,255,255,.3);padding:20px">Sin actividad todavía</div>') +
    '</div>' +
    '<div style="text-align:center;margin-top:20px;font-size:10px;color:rgba(255,255,255,.3)">NOVICASAS © 2026 — Servidor WhatsApp Twilio</div>' +
    '</body></html>');
});

// ═══ INICIAR ═══
app.listen(CONFIG.PORT, function () {
  console.log('\n═══════════════════════════════════════════════');
  console.log('🏠 NOVICASAS — Servidor WhatsApp ACTIVO');
  console.log('═══════════════════════════════════════════════');
  console.log('🌐 http://localhost:' + CONFIG.PORT);
  console.log('⏰ Recordatorios: ' + CONFIG.HORA_RECORDATORIO + ' AM');
  console.log('📱 Cobros: ' + CONFIG.HORA_COBRO + ' AM');
  console.log('🚨 Mora: ' + CONFIG.HORA_MORA + ' AM');
  console.log('🔗 Webhook: /webhook');
  console.log('═══════════════════════════════════════════════\n');

  var db = loadDB();
  var a = analizarPagos(db);
  console.log('📊 ' + a.recordatorios.length + ' recordatorios, ' + a.cobrosHoy.length + ' cobros hoy, ' + a.enMora.length + ' en mora');
});
