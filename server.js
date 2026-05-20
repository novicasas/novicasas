const express = require('express');
const cron = require('node-cron');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({limit:'50mb'}));
app.use(express.urlencoded({extended:true,limit:'50mb'}));
app.use(function(req,res,next){res.header('Access-Control-Allow-Origin','*');res.header('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.sendStatus(200);next();});

// ═══ TWILIO ═══
const ACCOUNT_SID = process.env.TWILIO_SID || 'AC17e18ff3847ed384ceb89f5cfac0bc20';
const AUTH_TOKEN = process.env.TWILIO_TOKEN || '72be396213cac707abf745adab5259fd';
const TWILIO_WA = 'whatsapp:+14155238886';
const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

const CONFIG = {
  PROPIETARIOS: {
    CEL:{nombre:'CELAQUE S.R.L.',banco:'BANCO NACIONAL DE BOLIVIA',cuenta:'2000170755'},
    A:{nombre:'Alvaro Heredia Novillo',banco:'BANCO ECONOMICO S.A.',cuenta:'2081318318'},
    D:{nombre:'David Heredia Novillo',banco:'BANCO ECONOMICO S.A.',cuenta:'1061318313'}
  },
  PORT: process.env.PORT || 3000
};

// ═══ DATABASE ═══
const DB_PATH = path.join(__dirname,'data.json');
function loadDB(){try{if(fs.existsSync(DB_PATH))return JSON.parse(fs.readFileSync(DB_PATH,'utf8'));}catch(e){}return{ventas:[],clientes:[],lotes:[],logEnvios:[]};}
function saveDB(db){fs.writeFileSync(DB_PATH,JSON.stringify(db));}

// ═══ WHATSAPP ═══
async function enviarWA(tel,msg){
  try{
    let t=tel.replace(/\D/g,'');if(!t.startsWith('591'))t='591'+t;
    const m=await client.messages.create({body:msg,from:TWILIO_WA,to:'whatsapp:+'+t});
    console.log('✅ WA enviado a +'+t);return{ok:true,sid:m.sid};
  }catch(e){console.error('❌ WA error:',e.message);return{ok:false,error:e.message};}
}

// ═══ UTILS ═══
function hoy(){return new Date().toISOString().split('T')[0];}
function manana(){var d=new Date();d.setDate(d.getDate()+1);return d.toISOString().split('T')[0];}
function fmt(n){return Math.round(n).toLocaleString('en-US');}
function fmtF(f){return new Date(f+'T12:00:00').toLocaleDateString('es-BO');}

function analizarPagos(db){
  var h=hoy(),m=manana(),r={recordatorios:[],cobrosHoy:[],enMora:[]};
  (db.ventas||[]).forEach(function(v){
    if(!v.cronograma||!v.plan||v.plan<=0)return;
    var cli=(db.clientes||[]).find(function(c){return c.id==v.cliId;});
    var lot=(db.lotes||[]).find(function(l){return String(l.id)===String(v.lotId);});
    if(!cli||!lot)return;
    v.cronograma.forEach(function(c){
      if(c.pagado)return;
      var o={vta:v,cli:cli,lot:lot,cuota:c};
      if(c.fecha===m)r.recordatorios.push(o);
      else if(c.fecha===h)r.cobrosHoy.push(o);
      else if(c.fecha<h)r.enMora.push(o);
    });
  });
  return r;
}

function generarMsg(tipo,cli,lot,cuota,vta){
  var prop=CONFIG.PROPIETARIOS[lot.propietario||'D']||CONFIG.PROPIETARIOS.D;
  var banco='🏦 '+prop.banco+'\n💳 Cuenta: *'+prop.cuenta+'*\n👤 A nombre de: *'+prop.nombre+'*';
  var li='*'+(lot.codigo||'')+'* (CDA MZ'+(lot.mz||'')+' LT'+(lot.lt||'')+')';
  var fe=fmtF(cuota.fecha);
  var ref='NVC-'+vta.id+'-C'+cuota.num;
  if(tipo==='recordatorio')return'Estimado/a *'+cli.nom+' '+cli.ape+'*, le saluda *NOVICASAS* 🏠.\n\n⏰ *RECORDATORIO:* Mañana *'+fe+'* vence su cuota #'+cuota.num+' de *$'+fmt(cuota.monto)+' USD* del lote '+li+'.\n\n📌 Deposite a:\n'+banco+'\n\n📝 Ref: *'+ref+'*\n📸 Envíe comprobante como *foto* a este chat.\n\n¡Gracias! *NOVICASAS* 🏠';
  if(tipo==='cobro')return'Estimado/a *'+cli.nom+' '+cli.ape+'*, le saluda *NOVICASAS* 🏠.\n\n📅 *HOY vence* su cuota #'+cuota.num+' de *$'+fmt(cuota.monto)+' USD* del lote '+li+'.\n\n💰 Pague a:\n'+banco+'\n\n📝 Ref: *'+ref+'*\n📸 *Envíe foto del comprobante* y se registra automáticamente.\n\nGracias. *NOVICASAS* 🏠';
  if(tipo==='mora'){var dias=Math.floor((new Date()-new Date(cuota.fecha+'T12:00:00'))/86400000);return'Estimado/a *'+cli.nom+' '+cli.ape+'*,\n\n⚠️ *AVISO DE MORA — NOVICASAS* 🏠\n\nSu cuota #'+cuota.num+' de *$'+fmt(cuota.monto)+' USD* del lote '+li+' venció el *'+fe+'* (hace '+dias+' días).\n\n💰 Pague a:\n'+banco+'\n\n📝 Ref: *'+ref+'*\n📸 Envíe comprobante a este chat.\n\n*NOVICASAS* 🏠';}
  if(tipo==='confirmacion')return'✅ *PAGO REGISTRADO — NOVICASAS* 🏠\n\nEstimado/a *'+cli.nom+' '+cli.ape+'*, confirmamos su pago:\n\n📌 Cuota #'+cuota.num+'\n💰 Monto: *$'+fmt(cuota.monto)+' USD*\n📍 Lote: '+li+'\n📅 Fecha: '+new Date().toLocaleDateString('es-BO')+'\n\nSu cuota fue marcada como *PAGADA* ✅\n\n¡Gracias! *NOVICASAS* 🏠';
  return'';
}

// ═══ CRON JOBS ═══
cron.schedule('0 8 * * *',async function(){
  console.log('\n⏰ [AUTO] RECORDATORIOS...');
  var db=loadDB(),items=analizarPagos(db).recordatorios;
  for(var i of items){var msg=generarMsg('recordatorio',i.cli,i.lot,i.cuota,i.vta);var r=await enviarWA(i.cli.tel,msg);db.logEnvios.push({fecha:new Date().toISOString(),tipo:'recordatorio',cliente:i.cli.nom+' '+i.cli.ape,cuota:i.cuota.num,resultado:r.ok?'enviado':'error'});await new Promise(function(res){setTimeout(res,2000);});}
  saveDB(db);console.log('✅ '+items.length+' recordatorios');
});
cron.schedule('0 9 * * *',async function(){
  console.log('\n📱 [AUTO] COBROS...');
  var db=loadDB(),items=analizarPagos(db).cobrosHoy;
  for(var i of items){var msg=generarMsg('cobro',i.cli,i.lot,i.cuota,i.vta);var r=await enviarWA(i.cli.tel,msg);db.logEnvios.push({fecha:new Date().toISOString(),tipo:'cobro',cliente:i.cli.nom+' '+i.cli.ape,cuota:i.cuota.num,monto:i.cuota.monto,resultado:r.ok?'enviado':'error'});await new Promise(function(res){setTimeout(res,2000);});}
  saveDB(db);console.log('✅ '+items.length+' cobros');
});
cron.schedule('0 10 * * *',async function(){
  console.log('\n🚨 [AUTO] MORA...');
  var db=loadDB(),items=analizarPagos(db).enMora;
  var porCli={};items.forEach(function(i){var c=i.cli.id;if(!porCli[c])porCli[c]={cli:i.cli,lot:i.lot,vta:i.vta,cuotas:[]};porCli[c].cuotas.push(i.cuota);});
  for(var g of Object.values(porCli)){var msg=generarMsg('mora',g.cli,g.lot,g.cuotas[0],g.vta);await enviarWA(g.cli.tel,msg);await new Promise(function(res){setTimeout(res,2000);});}
  saveDB(db);console.log('✅ '+Object.keys(porCli).length+' avisos mora');
});

// ═══ WEBHOOK ═══
app.post('/webhook',async function(req,res){
  try{
    var from=(req.body.From||'').replace('whatsapp:','').replace('+','');
    var body=(req.body.Body||'').trim();
    var numMedia=parseInt(req.body.NumMedia||'0');
    console.log('\n📩 Mensaje de +'+from+': '+(numMedia>0?'[IMAGEN]':body));
    var db=loadDB();
    var cliente=db.clientes.find(function(c){var t=(c.tel||'').replace(/\D/g,'');return from.endsWith(t)||t.endsWith(from.slice(-8));});
    if(!cliente){await enviarWA(from,'Hola! Soy el sistema de *NOVICASAS* 🏠.\nNo encontramos su número. Contacte: +591 708714251');return res.status(200).send('OK');}
    if(numMedia>0){
      var venta=db.ventas.find(function(v){return v.cliId==cliente.id&&parseInt(v.plan)>0;});
      if(!venta||!venta.cronograma){await enviarWA(from,'Hola *'+cliente.nom+'*, no encontramos cuotas pendientes.');return res.status(200).send('OK');}
      var cuota=venta.cronograma.find(function(c){return!c.pagado;});
      if(!cuota){await enviarWA(from,'Hola *'+cliente.nom+'*, todas sus cuotas están al día. 🎉');return res.status(200).send('OK');}
      cuota.pagado=true;cuota.fechaPago=hoy();cuota.metodo='WhatsApp Auto';cuota.ref='Comprobante WA - '+new Date().toLocaleString('es-BO');
      var lot=db.lotes.find(function(l){return String(l.id)===String(venta.lotId);});
      await enviarWA(from,generarMsg('confirmacion',cliente,lot||{},cuota,venta));
      db.logEnvios.push({fecha:new Date().toISOString(),tipo:'pago_auto',cliente:cliente.nom+' '+cliente.ape,cuota:cuota.num,monto:cuota.monto,resultado:'pagado_auto'});
      saveDB(db);console.log('✅ PAGO AUTO: Cuota #'+cuota.num+' de '+cliente.nom);
    }else{
      var venta=db.ventas.find(function(v){return v.cliId==cliente.id&&parseInt(v.plan)>0;});
      if(venta&&venta.cronograma){
        var pagadas=venta.cronograma.filter(function(c){return c.pagado;}).length;
        var total=venta.cronograma.length;
        var prox=venta.cronograma.find(function(c){return!c.pagado;});
        var lot=db.lotes.find(function(l){return String(l.id)===String(venta.lotId);});
        var resp='Hola *'+cliente.nom+'* 🏠\n\n📊 *Su cuenta:*\n📍 Lote: *'+(lot?lot.codigo:'N/A')+'*\n✅ Pagadas: *'+pagadas+'/'+total+'* ('+Math.round(pagadas/total*100)+'%)\n';
        if(prox)resp+='\n📅 Próxima: #'+prox.num+' — *$'+fmt(prox.monto)+' USD*\nVence: *'+fmtF(prox.fecha)+'*\n';
        resp+='\n📸 Envíe *foto del comprobante* para registrar pago.\n\n*NOVICASAS* 🏠';
        await enviarWA(from,resp);
      }else{await enviarWA(from,'Hola *'+cliente.nom+'* 🏠\nEscriba *"estado"* o envíe *foto del comprobante*.\nAtención: +591 708714251');}
    }
    res.status(200).send('OK');
  }catch(e){console.error('Webhook error:',e);res.status(200).send('OK');}
});

// ═══ API ═══
app.post('/api/sync',function(req,res){
  var db=loadDB();
  if(req.body.ventas)db.ventas=req.body.ventas;
  if(req.body.clientes)db.clientes=req.body.clientes;
  if(req.body.lotes)db.lotes=req.body.lotes;
  saveDB(db);
  res.json({ok:true,ventas:db.ventas.length,clientes:db.clientes.length,lotes:db.lotes.length});
});

app.get('/api/data',function(req,res){
  var db=loadDB();
  res.json({clientes:db.clientes,lotes:db.lotes,ventas:db.ventas});
});

app.get('/api/pagos',function(req,res){
  var db=loadDB();var a=analizarPagos(db);
  res.json({recordatorios:a.recordatorios.length,cobrosHoy:a.cobrosHoy.length,enMora:a.enMora.length,log:(db.logEnvios||[]).slice(-20)});
});

app.post('/api/enviar',async function(req,res){var r=await enviarWA(req.body.telefono,req.body.mensaje);res.json(r);});

app.post('/api/forzar/:tipo',async function(req,res){
  var db=loadDB(),a=analizarPagos(db);
  var items=req.params.tipo==='recordatorios'?a.recordatorios:req.params.tipo==='cobros'?a.cobrosHoy:a.enMora;
  var n=0;
  for(var i of items){
    var t=req.params.tipo==='recordatorios'?'recordatorio':req.params.tipo==='cobros'?'cobro':'mora';
    var msg=generarMsg(t,i.cli,i.lot,i.cuota,i.vta);await enviarWA(i.cli.tel,msg);n++;
    await new Promise(function(r){setTimeout(r,2000);});
  }
  res.json({ok:true,enviados:n});
});

// ═══ SERVE HTML ═══
app.get('/panel',function(req,res){
  var db=loadDB();var a=analizarPagos(db);var log=(db.logEnvios||[]).slice(-10).reverse();
  res.send('<!DOCTYPE html><html><head><title>NOVICASAS Panel</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#0A3622;color:#fff;margin:0;padding:20px}h1{text-align:center;font-size:22px;margin-bottom:4px}.sub{text-align:center;color:#4ade80;font-size:12px;margin-bottom:20px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:16px}.st{background:rgba(255,255,255,.08);border-radius:10px;padding:14px;text-align:center}.st .n{font-size:26px;font-weight:800;color:#f0c040}.st .l{font-size:9px;color:rgba(255,255,255,.5);margin-top:2px}.btns{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;justify-content:center}.btn{padding:9px 16px;border-radius:8px;border:none;font-weight:700;cursor:pointer;font-size:11px}.br{background:#f59e0b;color:#000}.bc{background:#25D366;color:#fff}.bm{background:#ef4444;color:#fff}.bu{background:#3b82f6;color:#fff}.ba{background:#fff;color:#0A3622}.log{background:rgba(0,0,0,.2);border-radius:8px;padding:12px;max-height:250px;overflow-y:auto}.li{padding:5px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:11px;color:rgba(255,255,255,.7)}</style></head><body><h1>🏠 NOVICASAS</h1><div class="sub">Panel de Automatización WhatsApp — ACTIVO ✅</div><div class="stats"><div class="st"><div class="n">'+a.recordatorios.length+'</div><div class="l">Vencen mañana</div></div><div class="st"><div class="n" style="color:#25D366">'+a.cobrosHoy.length+'</div><div class="l">Vencen hoy</div></div><div class="st"><div class="n" style="color:#ef4444">'+a.enMora.length+'</div><div class="l">En mora</div></div><div class="st"><div class="n" style="color:#3b82f6">'+db.ventas.filter(function(v){return parseInt(v.plan)>0;}).length+'</div><div class="l">Contratos</div></div></div><div class="btns"><button class="btn br" onclick="fetch(\'/api/forzar/recordatorios\',{method:\'POST\'}).then(r=>r.json()).then(d=>alert(d.enviados+\' enviados\'))">⏰ Recordatorios</button><button class="btn bc" onclick="fetch(\'/api/forzar/cobros\',{method:\'POST\'}).then(r=>r.json()).then(d=>alert(d.enviados+\' enviados\'))">📱 Cobros</button><button class="btn bm" onclick="fetch(\'/api/forzar/mora\',{method:\'POST\'}).then(r=>r.json()).then(d=>alert(d.enviados+\' enviados\'))">🚨 Mora</button><button class="btn bu" onclick="location.reload()">🔄</button><button class="btn ba" onclick="location.href=\'/\'">📋 Sistema</button></div><div style="font-size:10px;color:rgba(255,255,255,.4);text-align:center;margin-bottom:12px">Auto: Rec 08:00 · Cobros 09:00 · Mora 10:00 · '+new Date().toLocaleString('es-BO')+'</div><h3 style="font-size:13px;margin-bottom:6px">📋 Últimos envíos</h3><div class="log">'+(log.length?log.map(function(l){return'<div class="li">'+(l.tipo==='pago_auto'?'✅':l.tipo==='recordatorio'?'⏰':'📱')+' '+l.cliente+' — C#'+l.cuota+' — '+l.resultado+' — '+new Date(l.fecha).toLocaleString('es-BO')+'</div>';}).join(''):'<div style="text-align:center;color:rgba(255,255,255,.3);padding:16px">Sin actividad</div>')+'</div><div style="text-align:center;margin-top:16px;font-size:9px;color:rgba(255,255,255,.25)">NOVICASAS © 2026</div></body></html>');
});

app.get('/',function(req,res){
  res.sendFile(path.join(__dirname,'index.html'));
});

// ═══ START ═══
app.listen(CONFIG.PORT,function(){
  console.log('\n═══════════════════════════════════════');
  console.log('🏠 NOVICASAS — ONLINE');
  console.log('═══════════════════════════════════════');
  console.log('🌐 http://localhost:'+CONFIG.PORT);
  console.log('📋 Panel WA: /panel');
  console.log('⏰ Rec: 08:00 · Cobros: 09:00 · Mora: 10:00');
  console.log('═══════════════════════════════════════\n');
  var db=loadDB(),a=analizarPagos(db);
  console.log('📊 '+a.recordatorios.length+' rec, '+a.cobrosHoy.length+' hoy, '+a.enMora.length+' mora, '+db.ventas.length+' contratos');
});
