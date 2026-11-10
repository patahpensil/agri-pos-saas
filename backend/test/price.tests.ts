// Uji modul harga FREE/PRO: 16 skenario independen direct dan PgBouncer.
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { AppConfig } from "../src/config/config";
import {
  RUNTIME_HOST,RUNTIME_PORT,DBNAME,TEST_OTP_MAC_KEY,PW,admin,eq,errOf,ok,test,
  harnessSender,registerOwnerSql,makePro,inviteAndActivateAdminSql,
} from "./harness";

const K="API";
let base="";
type Result={status:number;body:Record<string,unknown>;text:string};
async function http(method:string,path:string,token:string|undefined,body?:unknown,key?:string):Promise<Result>{
  const h:Record<string,string>={};
  if(body!==undefined)h["content-type"]="application/json";
  if(token)h.authorization="Bearer "+token;
  if(key)h["idempotency-key"]=key;
  const r=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();let json:Record<string,unknown>={};
  try{json=text?JSON.parse(text):{};}catch{ /* not JSON */ }
  return {status:r.status,body:json,text};
}
let seq=0;
const productBody=(subsidized=false)=>({
  sku:"PRICE-"+(seq++).toString(36).toUpperCase()+"-"+randomUUID().slice(0,8).toUpperCase(),
  name:"Produk Harga Uji",category:subsidized?"FERTILIZER":"PESTICIDE",subsidized,baseUnit:"unit",
  packages:[
    {key:"unit",form:"LOOSE",factor:1,label:"Unit"},
    {key:"box",form:"SEALED",factor:12,label:"Karton 12",mayOpen:true},
  ],
  opening:[{packageKey:"unit",qty:0,cost:{basis:"KNOWN",totalIdr:0}}],
});
type P={id:string;unit:string;box:string;version:number};
async function product(token:string,subsidized=false):Promise<P>{
  const r=await http("POST","/products",token,productBody(subsidized),randomUUID());
  eq(r.status,201,"buat produk: "+r.text);
  const p=r.body.product as {packages:{id:string;label:string}[];version:number};
  return {id:String(r.body.productId),unit:p.packages.find(x=>x.label==="Unit")!.id,
    box:p.packages.find(x=>x.label==="Karton 12")!.id,version:p.version};
}
const input=(p:P,type:"RETAIL"|"WHOLESALE"|"PROMO"="RETAIL",extra:Record<string,unknown>={})=>({
  productId:p.id,packageId:p.unit,ruleType:type,minQty:type==="WHOLESALE"?3:1,
  priceIdr:12500,expectedVersion:p.version,reason:"Harga dari Owner disahkan",...extra,
});
const submit=(token:string,b:unknown,key=randomUUID())=>http("POST","/price-change-requests",token,b,key);
const prices=(token:string,id:string)=>http("GET","/products/"+id+"/prices",token);
async function reauth(token:string,id:string,v:number,password=PW):Promise<Result>{
  return http("POST","/auth/reauth",token,
    {password,action:"price.approve",targetId:id,scope:{expectedVersion:v}});
}
const approve=(token:string,id:string,v:number,re:string,key=randomUUID())=>
  http("POST","/price-change-requests/"+id+"/approve",token,
    {expectedVersion:v,reason:"Pemeriksaan harga Owner",reauthToken:re},key);
async function approved(token:string,p:P,type:"RETAIL"|"WHOLESALE"|"PROMO"="RETAIL",extra:Record<string,unknown>={}):Promise<Result>{
  const sub=await submit(token,input(p,type,extra));eq(sub.status,201,"ajuan: "+sub.text);
  const id=String(sub.body.requestId),g=await reauth(token,id,p.version);
  eq(g.status,201,"reauth: "+g.text);
  const res=await approve(token,id,p.version,String(g.body.reauthToken));
  eq(res.status,200,"approval: "+res.text);
  return res;
}
const rows=async(sql:string,args:unknown[]=[])=>admin<{n:number}>(sql,args).then(x=>x[0].n);
export async function priceTests():Promise<void>{
  const cfg:AppConfig={
    mode:"test",port:0,
    db:{host:RUNTIME_HOST,port:RUNTIME_PORT,database:DBNAME,poolMax:20,
      auth:{user:"auth_runtime",password:undefined},
      app:{user:"app_runtime",password:undefined},
      otp:{user:"otp_dispatch_runtime",password:undefined}},
    otpSender:"test",ipHashSecret:Buffer.from("TEST_ONLY_ip_hash_secret_pricing_0123456789"),
    otpMacKey:TEST_OTP_MAC_KEY,otpDispatchIntervalMs:1000,trustProxyHops:0,
  };
  const {app,db}=await createApp(cfg,{otpSender:harnessSender});
  await app.listen(0,"127.0.0.1");
  base="http://127.0.0.1:"+((app.getHttpServer().address() as AddressInfo).port)+"/api/v1";
  try{
    const o=await registerOwnerSql("Kios Uji Harga PRO");
    await makePro(o.tenant);
    const adm=await inviteAndActivateAdminSql(o);
    const free=await registerOwnerSql("Kios Uji Harga FREE");
    const other=await registerOwnerSql("Kios Uji Harga Lain");
    await makePro(other.tenant);

    await test("PRICE-01",K,"Eceran terpisah untuk unit dan karton",async()=>{
      const p=await product(o.token);
      await approved(o.token,p);
      const q={...p,version:2};
      await approved(o.token,q,"RETAIL",{packageId:p.box,priceIdr:130000});
      const r=await prices(o.token,p.id);eq(r.status,200,"GET harga");
      const rules=r.body.rules as {packageId:string;priceIdr:number}[];
      eq(rules.length,2,"dua harga");eq(rules.find(x=>x.packageId===p.unit)?.priceIdr,12500,"unit");
      eq(rules.find(x=>x.packageId===p.box)?.priceIdr,130000,"karton");
      return "2 harga per varian, faktornya tetap berbeda";
    });

    await test("PRICE-02",K,"Harga negatif, pecahan, dan string ditolak",async()=>{
      const p=await product(o.token);
      for(const price of [-1,1.5,"12500"]){
        const r=await submit(o.token,input(p,"RETAIL",{priceIdr:price}));
        eq(r.status,400,"harga tidak sah "+price);
      }
      eq(await rows("select count(*)::int n from biz.price_change_request where tenant_id=$1 and product_id=$2",[o.tenant,p.id]),0,"tidak tersimpan");
      return "3 payload harga tidak sah ditolak sebelum tulis";
    });

    await test("PRICE-03",K,"FREE Owner bisa menetapkan eceran setelah reauth",async()=>{
      const p=await product(free.token);
      await approved(free.token,p,"RETAIL",{priceIdr:15000});
      const r=await prices(free.token,p.id);
      eq((r.body.rules as unknown[]).length,1,"satu harga");
      return "FREE Owner: proposal+reauth+approval eceran sah";
    });

    await test("PRICE-04",K,"FREE tidak dapat mengajukan grosir dan promo",async()=>{
      const p=await product(free.token);
      const q=[input(p,"WHOLESALE"),input(p,"PROMO",{quotaUnits:5,startsAt:"2030-01-01T00:00:00Z",endsAt:"2031-01-01T00:00:00Z"})];
      for(const x of q){
        const r=await submit(free.token,x);
        eq(r.status,403,"FREE gated "+r.text);eq(r.body.code,"FEATURE_GATED_PLAN","kode");
      }
      return "grosir dan promo FREE ditolak backend";
    });

    await test("PRICE-05",K,"Admin PRO mengajukan; pengajuan belum menjadi harga aktif",async()=>{
      const p=await product(o.token);
      const a=await submit(adm.token,input(p));
      eq(a.status,201,"admin mengajukan");
      const r=await prices(o.token,p.id);
      eq((r.body.rules as unknown[]).length,0,"harga tidak boleh aktif sebelum approval");
      eq((r.body.requests as {state:string}[])[0].state,"PENDING","status");
      return "Admin submit PENDING; tidak ada rule aktif";
    });

    await test("PRICE-06",K,"Admin tidak boleh menyetujui harga",async()=>{
      const p=await product(o.token),s=await submit(adm.token,input(p));
      eq(s.status,201,"ajuan");
      const r=await approve(adm.token,String(s.body.requestId),p.version,"a".repeat(64));
      eq(r.status,403,"Admin approve");eq(r.body.code,"FORBIDDEN_ROLE","kode");
      eq((await prices(o.token,p.id)).body.rules instanceof Array,true,"harga");
      eq((await prices(o.token,p.id)).body.rules instanceof Array && ((await prices(o.token,p.id)).body.rules as unknown[]).length,0,"no rule");
      return "Admin approve => 403; tidak ada penerbitan harga";
    });

    await test("PRICE-07",K,"Owner reauth wajib, terikat pengajuan+versi dan satu kali",async()=>{
      const p=await product(o.token);
      const s=await submit(adm.token,input(p));
      const id=String(s.body.requestId);
      const forged=await approve(o.token,id,p.version,"f".repeat(64));
      eq(forged.status,403,"token palsu");
      const g=await reauth(o.token,id,p.version);eq(g.status,201,"reauth");
      const tok=String(g.body.reauthToken);
      const ok1=await approve(o.token,id,p.version,tok);eq(ok1.status,200,"Owner approve");
      const replay=await approve(o.token,id,p.version,tok);eq(replay.status,409,"token tidak dapat menerbitkan lagi");
      return "bukti palsu ditolak; satu reauth menerbitkan satu rule";
    });

    await test("PRICE-08",K,"Approval versi produk yang sudah berubah ditolak",async()=>{
      const p=await product(o.token),s=await submit(adm.token,input(p));
      const id=String(s.body.requestId);
      const patch=await http("PATCH","/products/"+p.id,o.token,{expectedVersion:1,name:"Produk berubah"});
      eq(patch.status,200,"ubah versi");
      const g=await reauth(o.token,id,1);eq(g.status,201,"reauth");
      const r=await approve(o.token,id,1,String(g.body.reauthToken));
      eq(r.status,409,"stale");eq(r.body.code,"VERSION_CONFLICT","kode");
      eq((await prices(o.token,p.id)).body.rules instanceof Array && ((await prices(o.token,p.id)).body.rules as unknown[]).length,0,"tidak ada harga");
      return "object_version berubah -> 409; harga tidak diterbitkan";
    });

    await test("PRICE-09",K,"Cross-tenant package tidak dapat diberi harga",async()=>{
      const p=await product(o.token),foreign=await product(other.token);
      const r=await submit(o.token,input(p,"RETAIL",{packageId:foreign.unit}));
      eq(r.status,404,"package toko lain ditolak");
      return "FK tenant dan pencarian package terikat tenant";
    });

    await test("PRICE-10",K,"Pengajuan tak ditanggapi tetap PENDING tanpa perubahan harga",async()=>{
      const p=await product(o.token);
      const s=await submit(adm.token,input(p));eq(s.status,201,"ajuan");
      const first=await prices(o.token,p.id);
      const second=await prices(o.token,p.id);
      for(const result of [first,second]){
        eq((result.body.rules as unknown[]).length,0,"rule belum diterbitkan");
        eq((result.body.requests as {state:string}[])[0].state,"PENDING","status");
      }
      return "pending tidak otomatis diapprove; koreksi/retur belum dibangun";
    });

    await test("PRICE-11",K,"Idempotensi key sama dan isi beda ditolak",async()=>{
      const p=await product(o.token),key=randomUUID(),b=input(p);
      const first=await submit(o.token,b,key),again=await submit(o.token,b,key);
      eq(first.status,201,"first");eq(again.status,201,"replay");
      eq(first.body.requestId,again.body.requestId,"satu request");
      eq(again.body.replayed,true,"flag replay");
      const diff=await submit(o.token,{...b,priceIdr:9900},key);
      eq(diff.status,409,"payload beda");eq(diff.body.code,"IDEMPOTENCY_PAYLOAD_MISMATCH","kode");
      return "1 proposal, retry aman, isi beda 409";
    });

    await test("PRICE-12",K,"Permintaan harga serentak idempotent",async()=>{
      const p=await product(o.token),b=input(p),key=randomUUID();
      const results=await Promise.all(Array.from({length:8},()=>submit(o.token,b,key)));
      ok(results.every(x=>x.status===201),results.map(x=>x.text).join(" | "));
      eq(new Set(results.map(x=>x.body.requestId)).size,1,"satu id");
      eq(await rows("select count(*)::int n from biz.price_change_request where tenant_id=$1 and product_id=$2",[o.tenant,p.id]),1,"satu row");
      return "8 request -> satu pengajuan";
    });

    await test("PRICE-13",K,"Dua approval serentak tidak menerbitkan ganda",async()=>{
      const p=await product(o.token),s=await submit(o.token,input(p)),id=String(s.body.requestId);
      const g1=await reauth(o.token,id,p.version),g2=await reauth(o.token,id,p.version);
      eq(g1.status,201,"reauth1");eq(g2.status,201,"reauth2");
      const res=await Promise.all([
        approve(o.token,id,p.version,String(g1.body.reauthToken)),
        approve(o.token,id,p.version,String(g2.body.reauthToken)),
      ]);
      eq(res.filter(x=>x.status===200).length,1,"satu approval");
      eq(res.filter(x=>x.status===409).length,1,"satu ditolak");
      eq(await rows("select count(*)::int n from biz.price_rule_version where tenant_id=$1 and request_id=$2",[o.tenant,id]),1,"satu rule");
      return "dua Owner request concurrent => tepat satu rule";
    });

    await test("PRICE-14",K,"Riwayat harga append-only dan hak tabel runtime tertutup",async()=>{
      const p=await product(o.token),ap=await approved(o.token,p),rule=String(ap.body.ruleId);
      const bad=[
        await errOf(admin("update biz.price_rule_version set price_idr=1 where tenant_id=$1 and id=$2",[o.tenant,rule])),
        await errOf(admin("delete from biz.price_rule_version where tenant_id=$1 and id=$2",[o.tenant,rule])),
      ];
      ok(bad.every(x=>x==="APPEND_ONLY"),bad.join("|"));
      const perm=await admin<{ok:boolean}>("select has_table_privilege('app_runtime','biz.price_rule_version','UPDATE') ok");
      eq(perm[0].ok,false,"runtime tidak boleh ubah tabel");
      return "update/delete ditolak termasuk superuser; runtime tanpa privilege";
    });

    await test("PRICE-15",K,"PRO menerima harga grosir dan promo berkuota tanpa mengurangi kuota saat draft",async()=>{
      const p=await product(o.token);
      await approved(o.token,p,"WHOLESALE",{minQty:6,priceIdr:11000});
      await approved(o.token,{...p,version:2},"PROMO",{priceIdr:10000,quotaUnits:3,
        startsAt:"2030-01-01T00:00:00Z",endsAt:"2031-01-01T00:00:00Z"});
      const r=await prices(o.token,p.id),rules=r.body.rules as {ruleType:string;minQty:number;quotaUnits:number|null;usedUnits:number}[];
      eq(rules.length,2,"dua aturan");
      eq(rules.find(x=>x.ruleType==="WHOLESALE")?.minQty,6,"jumlah minimum");
      eq(rules.find(x=>x.ruleType==="PROMO")?.quotaUnits,3,"kuota");
      eq(rules.find(x=>x.ruleType==="PROMO")?.usedUnits,0,"draft tidak memakai kuota");
      return "grosir minQty=6; promo quota=3 used=0 (checkout belum ada)";
    });

    await test("PRICE-16",K,"Subsidi tidak boleh mendapat harga POS umum; payload asing ditolak",async()=>{
      const p=await product(o.token,true);
      const blocked=await submit(o.token,input(p));
      eq(blocked.status,409,"subsidi block");eq(blocked.body.code,"SUBSIDY_PRICE_SEPARATE","kode");
      const normal=await product(o.token);
      const forged=await submit(o.token,{...input(normal),tenant_id:other.tenant});
      eq(forged.status,400,"tenant_id ditolak");
      return "subsidi terpisah, tenant_id asing ditolak";
    });
  }finally{
    await app.close();await db.close();
  }
}
