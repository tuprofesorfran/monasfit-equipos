/* Lectura de los PDF «Resultados de Composición Corporal» de la báscula Tanita.
   Todo ocurre en el navegador: el PDF no sale del dispositivo, solo se envían los pocos números que usa el ranking. */
(function(){
  function num(s){var m=String(s).replace(",",".").match(/-?\d+(\.\d+)?/);return m?parseFloat(m[0]):null;}
  function inR(v,a,b){return v!=null&&v>=a&&v<=b;}
  function fromItems(items){
    items=items.map(function(i){return {s:String(i.s).trim(),x:i.x,y:i.y};}).filter(function(i){return i.s;});
    var o={name:"",age:null,height:null,date:"",peso:null,grasa:null,masaMusc:null,edadMet:null,visc:null,init:null,rows:[]};
    var fe=items.filter(function(i){return i.y<100&&i.x>300&&/^\d{2}\/\d{2}\/\d{4}/.test(i.s);})[0];
    if(!fe)return null;
    var d=fe.s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);o.date=d[3]+"-"+d[2]+"-"+d[1];
    var left=items.filter(function(i){return i.x<100&&i.y<130;}).sort(function(a,b){return a.y-b.y;});
    if(left.length>=3){o.name=left[1].s;o.age=num(left[2].s);}
    var h=items.filter(function(i){return i.y<130&&/^\d{3}\s*cm$/.test(i.s);})[0];if(h)o.height=num(h.s);
    var det=items.filter(function(i){return i.x>=105&&i.x<=125&&i.y>=150&&i.y<=250;}).sort(function(a,b){return a.y-b.y;});
    if(det.length!==7)return null;
    if(!/kg$/.test(det[0].s)||det[1].s.indexOf("%")<0||!/kg$/.test(det[4].s))return null;
    o.peso=num(det[0].s);o.grasa=num(det[1].s);o.masaMusc=num(det[4].s);o.edadMet=num(det[6].s);
    var vi=items.filter(function(i){return i.x>=120&&i.x<=140&&i.y>=320&&i.y<=355&&/^\d+(\.\d)?$/.test(i.s);})[0];if(vi)o.visc=num(vi.s);
    if(!inR(o.peso,20,300)||!inR(o.grasa,1,70)||!inR(o.masaMusc,10,200))return null;
    if(o.edadMet!=null&&!inR(o.edadMet,5,100))o.edadMet=null;
    if(o.visc!=null&&!inR(o.visc,1,59))o.visc=null;
    // Tabla «Historial» del pie: filas «Initial» y con fecha, con peso, masa muscular y % de grasa.
    var low=items.filter(function(i){return i.y>=700;});
    var ys=[];low.forEach(function(i){if(i.x<70&&(/^Initial$/i.test(i.s)||/^\d{2}\.\d{2}\.\d{4}$/.test(i.s)))ys.push(i);});
    ys.forEach(function(lab){
      var vals=low.filter(function(i){return Math.abs(i.y-lab.y)<=3&&i.x>=80&&i.x<=200;}).sort(function(a,b){return a.x-b.x;}).map(function(i){return num(i.s);});
      if(vals.length!==3||!inR(vals[0],20,300)||!inR(vals[1],10,200)||!inR(vals[2],1,70))return;
      var r={peso:vals[0],musculo:vals[1],grasa:vals[2]};
      if(/^Initial$/i.test(lab.s))o.init=r;
      else{var m=lab.s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);r.date=m[3]+"-"+m[2]+"-"+m[1];o.rows.push(r);}
    });
    o.rows.sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0;});
    if(!o.rows.length)o.rows.push({date:o.date,peso:o.peso,musculo:o.masaMusc,grasa:o.grasa});
    return o;
  }
  async function read(file){
    if(!file||!/\.pdf$/i.test(file.name))return null;
    try{
      var m=await import("/vendor/pdfjs/pdf.min.mjs");
      m.GlobalWorkerOptions.workerSrc="/vendor/pdfjs/pdf.worker.min.mjs";
      var data=new Uint8Array(await file.arrayBuffer());
      var doc=await m.getDocument({data:data}).promise;
      var pg=await doc.getPage(1),tc=await pg.getTextContent(),H=pg.view[3];
      var items=tc.items.map(function(i){return {s:i.str,x:Math.round(i.transform[4]),y:Math.round(H-i.transform[5])};});
      return fromItems(items);
    }catch(e){return null;}
  }
  function norm(s){return String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z ]/g," ").split(/\s+/).filter(function(w){return w.length>1;});}
  function sameName(a,b){var A=norm(a),B=norm(b);if(!A.length||!B.length)return true;var c=A.filter(function(w){return B.indexOf(w)>=0;}).length;return c>=Math.min(2,Math.min(A.length,B.length));}
  function pack(o){return btoa(unescape(encodeURIComponent(JSON.stringify({d:o.date,e:o.age,p:o.peso,g:o.grasa,m:o.masaMusc,a:o.edadMet,v:o.visc,i:o.init,r:o.rows.slice(-13)})))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
  window.MFTanita={fromItems:fromItems,read:read,sameName:sameName,pack:pack};
})();
