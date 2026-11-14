// Uji modul harga FREE/PRO: 23 skenario independen direct dan PgBouncer.
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { AppConfig } from "../src/config/config";
import {
  RUNTIME_HOST,RUNTIME_PORT,DBNAME,TEST_OTP_MAC_KEY,PW,admin,asActor,eq,errOf,ok,test,
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
const input=(p:P,extra:Record<string,unknown>={})=>({
  productId:p.id,packageId:p.unit,
  priceIdr:12500,expectedVersion:p.version,reason:"Harga dari Owner disahkan",
  referenceDocument:"DAFTAR-HARGA-01",...extra,
});
const submit=(token:string,b:unknown,key=randomUUID())=>http("POST","/price-change-requests",token,b,key);
const prices=(token:string,id:string)=>http("GET","/products/"+id+"/prices",token);
async function reauth(token:string,id:string,v:number,password=PW):Promise<Result>{
  return http("POST","/auth/reauth",token,
    {password,action:"price.approve",targetId:id,scope:{expectedVersion:v}});
}
const approve=(token:string,id:string,v:number,re:string,key=randomUUID(),referenceDocument?:string)=>
  http("POST","/price-change-requests/"+id+"/approve",token,
    {expectedVersion:v,reason:"Pemeriksaan harga Owner",reauthToken:re,referenceDocument},key);
const reject=(token:string,id:string,v:number,key=randomUUID(),reason="Harga perlu ditinjau ulang")=>
  http("POST","/price-change-requests/"+id+"/reject",token,{expectedVersion:v,reason},key);
async function approved(token:string,p:P,extra:Record<string,unknown>={}):Promise<Result>{
  const sub=await submit(token,input(p,extra));eq(sub.status,201,"ajuan: "+sub.text);
  const id=String(sub.body.requestId),g=await reauth(token,id,p.version);
  eq(g.status,201,"reauth: "+g.text);
  const res=await approve(token,id,p.version,String(g.body.reauthToken));
  eq(res.status,200,"approval: "+res.text);
  return res;
}
const rows=async(sql:string,args:unknown[]=[])=>admin<{n:number}>(sql,args).then(x=>x[0].n);
const auditDetails=async(tenant:string,id:string,kind:string)=>admin<{detail:Record<string,unknown>}>(
  "select detail from biz.audit_event where tenant_id=$1 and entity_id=$2 and kind=$3",[tenant,id,kind],
);
type PriceFixture={
  o:Awaited<ReturnType<typeof registerOwnerSql>>;
  adm:Awaited<ReturnType<typeof inviteAndActivateAdminSql>>;
};
async function priceTest(id:string,title:string,run:(fixture:PriceFixture)=>Promise<string>):Promise<void>{
  await test(id,K,title,async()=>{
    const o=await registerOwnerSql("Kios "+id);
    await makePro(o.tenant);
    const adm=await inviteAndActivateAdminSql(o);
    return run({o,adm});
  });
}

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
    await priceTest("PRICE-01","Eceran terpisah untuk unit dan karton",async({o})=>{
      const p=await product(o.token);
      await approved(o.token,p);
      const q={...p,version:2};
      await approved(o.token,q,{packageId:p.box,priceIdr:130000});
      const r=await prices(o.token,p.id);eq(r.status,200,"GET harga");
      const rules=r.body.rules as {packageId:string;priceIdr:number}[];
      eq(rules.length,2,"dua harga");eq(rules.find(x=>x.packageId===p.unit)?.priceIdr,12500,"unit");
      eq(rules.find(x=>x.packageId===p.box)?.priceIdr,130000,"karton");
      return "2 varian: unit Rp12.500 dan karton Rp130.000";
    });

    await priceTest("PRICE-02","Harga negatif, pecahan, dan string ditolak",async({o})=>{
      const p=await product(o.token);
      for(const price of [-1,1.5,"12500"]){
        const r=await submit(o.token,input(p,{priceIdr:price}));
        eq(r.status,400,"harga tidak sah "+price);
      }
      eq(await rows("select count(*)::int n from biz.price_change_request where tenant_id=$1 and product_id=$2",[o.tenant,p.id]),0,"tidak tersimpan");
      return "3 payload harga tidak sah ditolak sebelum tulis";
    });

    await priceTest("PRICE-03","FREE Owner bisa menetapkan eceran setelah reauth",async()=>{
      const free=await registerOwnerSql("Kios harga FREE");
      const p=await product(free.token);
      await approved(free.token,p,{priceIdr:15000});
      const r=await prices(free.token,p.id);
      const rules=r.body.rules as {priceIdr:number}[];
      eq(rules.length,1,"satu harga");eq(rules[0].priceIdr,15000,"nilai eceran FREE");
      return "1 harga eceran FREE Rp15.000 terbit setelah reauth Owner";
    });

    await priceTest("PRICE-04","Field grosir dan promo ditolak oleh API dan database",async({o,adm})=>{
      const p=await product(o.token);
      const fields={
        ruleType:"WHOLESALE",minQty:6,quotaUnits:5,
        startsAt:"2030-01-01T00:00:00Z",endsAt:"2031-01-01T00:00:00Z",
      };
      for(const [field,value] of Object.entries(fields)){
        const body={...input(p),[field]:value};
        const r=await submit(adm.token,body);
        eq(r.status,400,field+" ditolak API");
        eq(await errOf(asActor(adm.token,"select app.price_submit($1,$2::jsonb)",[randomUUID(),body])),
          "VALIDATION",field+" ditolak database");
      }
      eq(await rows("select count(*)::int n from biz.price_change_request where tenant_id=$1",[o.tenant]),0,"tidak ada pengajuan");
      return "5 field ditolak 400 oleh API dan VALIDATION oleh database; 0 pengajuan";
    });

    await priceTest("PRICE-05","Admin PRO mengajukan; pengajuan belum menjadi harga aktif",async({o,adm})=>{
      const p=await product(o.token);
      const a=await submit(adm.token,input(p));
      eq(a.status,201,"admin mengajukan");
      const r=await prices(o.token,p.id);
      eq((r.body.rules as unknown[]).length,0,"harga tidak boleh aktif sebelum approval");
      eq((r.body.requests as {state:string}[])[0].state,"PENDING","status");
      return "1 pengajuan Admin PENDING; 0 harga terbit";
    });

    await priceTest("PRICE-06","Admin tidak boleh menyetujui harga",async({o,adm})=>{
      const p=await product(o.token),s=await submit(adm.token,input(p));
      eq(s.status,201,"ajuan");
      const r=await approve(adm.token,String(s.body.requestId),p.version,"a".repeat(64));
      eq(r.status,403,"Admin approve");eq(r.body.code,"FORBIDDEN_ROLE","kode");
      const price=await prices(o.token,p.id);
      eq(price.status,200,"Owner dapat memeriksa harga");
      eq((price.body.rules as unknown[]).length,0,"tidak ada harga terbit");
      return "1 persetujuan Admin ditolak 403 FORBIDDEN_ROLE; 0 harga terbit";
    });

    await priceTest("PRICE-07","Owner reauth wajib, terikat pengajuan+versi dan satu kali",async({o,adm})=>{
      const p=await product(o.token);
      const s=await submit(adm.token,input(p));
      eq(s.status,201,"usulan Admin");
      const id=String(s.body.requestId);
      const second=await submit(adm.token,input(p));
      eq(second.status,201,"usulan lain pada versi yang sama");
      const forged=await approve(o.token,id,p.version,"f".repeat(64));
      eq(forged.status,403,"token palsu");eq(forged.body.code,"REAUTH_REQUIRED","kode reauth");
      const g=await reauth(o.token,id,p.version);eq(g.status,201,"reauth");
      const tok=String(g.body.reauthToken);
      const wrongTarget=await approve(o.token,String(second.body.requestId),p.version,tok);
      eq(wrongTarget.status,403,"token tidak berlaku untuk usulan berbeda");
      eq(wrongTarget.body.code,"REAUTH_REQUIRED","target reauth");
      const ok1=await approve(o.token,id,p.version,tok);eq(ok1.status,200,"Owner approve");
      const replay=await approve(o.token,id,p.version,tok);eq(replay.status,409,"token tidak dapat menerbitkan lagi");
      return "2 token tidak sah ditolak 403; 1 persetujuan 200; keputusan ulang 409";
    });

    await priceTest("PRICE-08","Approval versi produk yang sudah berubah ditolak",async({o,adm})=>{
      const p=await product(o.token),s=await submit(adm.token,input(p));
      const id=String(s.body.requestId);
      const patch=await http("PATCH","/products/"+p.id,o.token,{expectedVersion:1,name:"Produk berubah"});
      eq(patch.status,200,"ubah versi");
      const g=await reauth(o.token,id,1);eq(g.status,201,"reauth");
      const r=await approve(o.token,id,1,String(g.body.reauthToken));
      eq(r.status,409,"stale");eq(r.body.code,"VERSION_CONFLICT","kode");
      eq((await prices(o.token,p.id)).body.rules instanceof Array && ((await prices(o.token,p.id)).body.rules as unknown[]).length,0,"tidak ada harga");
      return "Versi 1 ditolak 409 setelah produk menjadi versi 2; 0 harga terbit";
    });

    await priceTest("PRICE-09","Cross-tenant package tidak dapat diberi harga",async({o})=>{
      const other=await registerOwnerSql("Kios harga lain");
      await makePro(other.tenant);
      const p=await product(o.token),foreign=await product(other.token);
      const r=await submit(o.token,input(p,{packageId:foreign.unit}));
      eq(r.status,404,"package toko lain ditolak");
      return "1 kemasan toko lain ditolak 404";
    });

    await priceTest("PRICE-10","Pengajuan tak ditanggapi tetap PENDING tanpa perubahan harga",async({o,adm})=>{
      const p=await product(o.token);
      const s=await submit(adm.token,input(p));eq(s.status,201,"ajuan");
      const first=await prices(o.token,p.id);
      const second=await prices(o.token,p.id);
      for(const result of [first,second]){
        eq((result.body.rules as unknown[]).length,0,"rule belum diterbitkan");
        eq((result.body.requests as {state:string}[])[0].state,"PENDING","status");
      }
      return "2 kali dibaca: 1 pengajuan tetap PENDING dan 0 harga terbit";
    });

    await priceTest("PRICE-11","Idempotensi key sama dan isi beda ditolak",async({o})=>{
      const p=await product(o.token),key=randomUUID(),b=input(p);
      const first=await submit(o.token,b,key),again=await submit(o.token,b,key);
      eq(first.status,201,"first");eq(again.status,201,"replay");
      eq(first.body.requestId,again.body.requestId,"satu request");
      eq(again.body.replayed,true,"flag replay");
      const diff=await submit(o.token,{...b,priceIdr:9900},key);
      eq(diff.status,409,"payload beda");eq(diff.body.code,"IDEMPOTENCY_PAYLOAD_MISMATCH","kode");
      return "1 proposal, retry aman, isi beda 409";
    });

    await priceTest("PRICE-12","Permintaan harga serentak idempotent",async({o})=>{
      const p=await product(o.token),b=input(p),key=randomUUID();
      const results=await Promise.all(Array.from({length:8},()=>submit(o.token,b,key)));
      ok(results.every(x=>x.status===201),results.map(x=>x.text).join(" | "));
      eq(new Set(results.map(x=>x.body.requestId)).size,1,"satu id");
      eq(await rows("select count(*)::int n from biz.price_change_request where tenant_id=$1 and product_id=$2",[o.tenant,p.id]),1,"satu row");
      return "8 request -> satu pengajuan";
    });

    await priceTest("PRICE-13","Dua approval serentak tidak menerbitkan ganda",async({o})=>{
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
      return "2 persetujuan serentak: 1 respons 200, 1 respons 409, 1 harga terbit";
    });

    await priceTest("PRICE-14","Riwayat harga append-only dan hak tabel runtime tertutup",async({o})=>{
      const p=await product(o.token),ap=await approved(o.token,p),rule=String(ap.body.ruleId);
      const bad=[
        await errOf(admin("update biz.price_rule_version set price_idr=1 where tenant_id=$1 and id=$2",[o.tenant,rule])),
        await errOf(admin("delete from biz.price_rule_version where tenant_id=$1 and id=$2",[o.tenant,rule])),
      ];
      ok(bad.every(x=>x==="APPEND_ONLY"),bad.join("|"));
      const perm=await admin<{ok:boolean}>("select has_table_privilege('app_runtime','biz.price_rule_version','UPDATE') ok");
      eq(perm[0].ok,false,"runtime tidak boleh ubah tabel");
      return "2 perubahan langsung oleh superuser ditolak; 0 hak UPDATE untuk runtime";
    });

    await priceTest("PRICE-15","Hanya Owner dapat menolak pengajuan, termasuk yang sudah basi",async({o,adm})=>{
      const original=await product(o.token);
      const active=await approved(o.token,original,{priceIdr:150000});
      const p={...original,version:Number(active.body.productVersion)};
      const fresh=await submit(adm.token,input(p,{priceIdr:160000}));
      eq(fresh.status,201,"Admin mengajukan");
      const id=String(fresh.body.requestId);
      const denied=await reject(adm.token,id,p.version);
      eq(denied.status,403,"Admin tidak dapat menolak");
      eq(denied.body.code,"FORBIDDEN_ROLE","kode Admin");
      eq(await errOf(asActor(o.token,"select app.price_reject($1,$2,$3::jsonb)",
        [randomUUID(),id,{expectedVersion:p.version,reason:"Tinjau lagi",extra:true}])),"VALIDATION","body DB strict");
      const key=randomUUID();
      const rejected=await reject(o.token,id,p.version,key);
      eq(rejected.status,200,"ditolak Owner tanpa reauth");
      eq(rejected.body.state,"REJECTED","status pengajuan");
      const replay=await reject(o.token,id,p.version,key);
      eq(replay.status,200,"ulang idempoten");
      eq(replay.body.replayed,true,"respons tersimpan");
      const changed=await reject(o.token,id,p.version,key,"Alasan yang berbeda");
      eq(changed.status,409,"isi berbeda pada kunci sama ditolak");
      eq(changed.body.code,"IDEMPOTENCY_PAYLOAD_MISMATCH","kode idempotensi");
      const decided=await reject(o.token,id,p.version);
      eq(decided.status,409,"pengajuan hanya boleh diputuskan sekali");
      eq(decided.body.code,"PRICE_ALREADY_REVIEWED","kode keputusan");
      ok(decided.text.includes("Pengajuan harga sudah diputuskan"),"pesan keputusan");
      const grant=await reauth(o.token,id,p.version);
      eq(grant.status,201,"reauth");
      const after=await approve(o.token,id,p.version,String(grant.body.reauthToken));
      eq(after.status,409,"tidak dapat menyetujui pengajuan yang ditolak");
      eq(after.body.code,"PRICE_ALREADY_REVIEWED","kode keputusan");
      eq(await rows("select version::int n from biz.product where tenant_id=$1 and id=$2",[o.tenant,p.id]),p.version,"versi tetap");
      const rules=(await prices(o.token,p.id)).body.rules as {priceIdr:number}[];
      eq(rules.length,1,"satu harga");eq(rules[0].priceIdr,150000,"harga tetap");
      const review=await auditDetails(o.tenant,id,"PRICE_REJECTED");
      eq(review.length,1,"satu audit penolakan");
      eq(review[0].detail.reason,"Harga perlu ditinjau ulang","alasan penolakan");
      eq(await rows(`select count(*)::int n from biz.price_change_request where tenant_id=$1 and id=$2
        and state='REJECTED' and rejected_by is not null and rejected_at is not null
        and approved_by is null and approved_at is null`,[o.tenant,id]),1,"metadata keputusan konsisten");

      const pending=await submit(adm.token,input(p,{priceIdr:165000}));
      eq(pending.status,201,"pengajuan sebelum edit produk");
      const patch=await http("PATCH","/products/"+p.id,o.token,{expectedVersion:p.version,name:"Nama baru"});
      eq(patch.status,200,"ubah versi produk");
      const stale=await reject(o.token,String(pending.body.requestId),p.version);
      eq(stale.status,200,"pengajuan basi tetap bisa ditolak");
      eq(stale.body.state,"REJECTED","keputusan pengajuan basi");
      eq(await rows("select version::int n from biz.product where tenant_id=$1 and id=$2",[o.tenant,p.id]),p.version+1,"versi hanya berubah karena edit produk");
      return "2 penolakan Owner mendapat 200; Admin 403; keputusan ulang 409; harga tetap Rp150.000";
    });

    await priceTest("PRICE-16","Subsidi tidak boleh mendapat harga POS umum; payload asing ditolak",async({o})=>{
      const other=await registerOwnerSql("Kios harga lain");
      const p=await product(o.token,true);
      const blocked=await submit(o.token,input(p));
      eq(blocked.status,409,"subsidi block");eq(blocked.body.code,"SUBSIDY_PRICE_SEPARATE","kode");
      const normal=await product(o.token);
      const forged=await submit(o.token,{...input(normal),tenant_id:other.tenant});
      eq(forged.status,400,"tenant_id ditolak");
      return "1 pupuk subsidi ditolak 409; 1 tenant_id asing ditolak 400";
    });
    await priceTest("PRICE-17","Faktor kemasan berharga yang disetujui terkunci sejak stok nol",async({o,adm})=>{
      const p=await product(o.token);
      const approval=await approved(o.token,p,{packageId:p.box,priceIdr:120000});
      const version=Number(approval.body.productVersion);
      const patch=await http("PATCH","/products/"+p.id,adm.token,{
        expectedVersion:version,packages:{update:[{id:p.box,factor:24}]},
      });
      eq(patch.status,409,"Admin tidak boleh mengubah isi varian berharga");
      eq(patch.body.code,"PACKAGE_FACTOR_LOCKED","kode faktor terkunci");
      eq(await errOf(admin("update biz.package_version set factor=24 where tenant_id=$1 and id=$2",[o.tenant,p.box])),
        "PACKAGE_FACTOR_LOCKED","guard database");
      const added=await http("PATCH","/products/"+p.id,adm.token,{
        expectedVersion:version,packages:{add:[{form:"SEALED",factor:24,label:"Karton 24",supersedesId:p.box}]},
      });
      eq(added.status,200,"varian baru boleh dibuat: "+added.text);
      eq(await rows("select factor n from biz.package_version where tenant_id=$1 and id=$2",[o.tenant,p.box]),12,"isi historis");
      const before=await prices(o.token,p.id);
      const rules=before.body.rules as {packageId:string;priceIdr:number}[];
      eq(rules.length,1,"varian baru belum diberi harga");
      eq(rules[0].packageId,p.box,"harga tetap melekat pada kemasan isi 12");
      eq(rules[0].priceIdr,120000,"harga yang disetujui");
      const racing=await product(o.token);
      const proposal=await submit(adm.token,input(racing,{packageId:racing.box,priceIdr:120000}));
      eq(proposal.status,201,"pengajuan untuk uji serentak");
      const requestId=String(proposal.body.requestId);
      const grant=await reauth(o.token,requestId,racing.version);
      eq(grant.status,201,"reauth untuk uji serentak");
      const [review,change]=await Promise.all([
        approve(o.token,requestId,racing.version,String(grant.body.reauthToken)),
        http("PATCH","/products/"+racing.id,adm.token,{
          expectedVersion:racing.version,packages:{update:[{id:racing.box,factor:24}]},
        }),
      ]);
      const reviewWon=review.status===200 && change.status===409;
      const editWon=change.status===200 && review.status===409;
      ok(reviewWon || editWon,`satu operasi harus berhasil: approval=${review.status}, edit=${change.status}`);
      eq(await rows("select factor n from biz.package_version where tenant_id=$1 and id=$2",[o.tenant,racing.box]),
        reviewWon?12:24,"isi setelah operasi serentak");
      eq(await rows("select count(*)::int n from biz.price_rule_version where tenant_id=$1 and request_id=$2",[o.tenant,requestId]),
        reviewWon?1:0,"harga setelah operasi serentak");
      return "Karton isi 12 berharga Rp120.000 tetap; karton isi 24 baru tanpa harga; dari 2 operasi serentak hanya 1 berhasil";
    });

    await priceTest("PRICE-18","Owner membaca pengajuan Admin dan audit menyimpan dokumen rujukan",async({o,adm})=>{
      const p=await product(o.token);
      const reason="Pemasok menaikkan harga satu karton",reference="DAFTAR-HARGA-KARTON-01";
      const s=await submit(adm.token,input(p,{packageId:p.box,priceIdr:150000,reason,referenceDocument:reference}));
      eq(s.status,201,"pengajuan karton: "+s.text);
      const id=String(s.body.requestId);
      const list=await prices(o.token,p.id);
      eq(list.status,200,"Owner membuka rincian: "+list.text);
      const [proposal]=list.body.requests as Record<string,unknown>[];
      eq(proposal.id,id,"ID pengajuan");eq(proposal.packageId,p.box,"varian");
      eq(proposal.packageLabel,"Karton 12","label");eq(proposal.packageFactor,12,"isi kemasan");
      eq(proposal.state,"PENDING","status");eq(proposal.expectedVersion,p.version,"versi");
      eq(proposal.priceIdr,150000,"harga");eq(proposal.reason,reason,"alasan");
      eq(proposal.referenceDocument,reference,"rujukan dari Admin");
      const grant=await reauth(o.token,id,p.version);
      eq(grant.status,201,"reauth");
      const accepted=await approve(o.token,id,p.version,String(grant.body.reauthToken));
      eq(accepted.status,200,"pakai rujukan dari pengajuan");
      const [audit]=await auditDetails(o.tenant,id,"PRICE_APPROVED");
      eq(audit.detail.referenceDocument,reference,"dokumen di audit");
      eq(audit.detail.selfSubmitted,false,"pengajuan dibuat Admin");
      eq(audit.detail.reason,"Pemeriksaan harga Owner","alasan Owner");
      ok(typeof audit.detail.reauthGrantId==="string","ID reauth di audit");
      return "1 pengajuan Admin untuk karton isi 12, Rp150.000; rujukan dan selfSubmitted=false tercatat";
    });

    await priceTest("PRICE-19","Sesi sah tidak dapat membaca harga setelah FREE/PRO berakhir",async({o,adm})=>{
      const free=await registerOwnerSql("Kios harga FREE");
      const proProduct=await product(o.token),freeProduct=await product(free.token);
      await approved(o.token,proProduct);
      await submit(free.token,input(freeProduct));
      await admin(
        "update platform.subscription set activated_at=now()-interval '8 days', expires_at=now()-interval '1 day', grace_deadline=now()+interval '6 days' where tenant_id=$1",
        [free.tenant]);
      await admin(
        "update platform.subscription set activated_at=now()-interval '31 days', expires_at=now()-interval '1 hour', grace_deadline=now()+interval '29 days' where tenant_id=$1",
        [o.tenant]);
      const sessions=[[free.token,freeProduct.id],[o.token,proProduct.id],[adm.token,proProduct.id]];
      for(const [token,productId] of sessions){
        const locked=await prices(token,productId);
        eq(locked.status,403,"harga terkunci: "+locked.text);
        eq(locked.body.code,"TENANT_LOCKED","kode paket berakhir");
        eq(await errOf(asActor(token,"select app.price_list($1)",[productId])),"TENANT_LOCKED","cek langsung di DB");
      }
      return "3 sesi aktif (1 FREE, 2 PRO) ditolak 403 oleh API dan TENANT_LOCKED di database";
    });

    await priceTest("PRICE-20","Rujukan wajib untuk pengajuan Admin dan opsional untuk pengajuan sendiri",async({o,adm})=>{
      const free=await registerOwnerSql("Kios PRICE-20 FREE");
      const p=await product(o.token);
      await approved(o.token,p,{priceIdr:150000});
      const updated={...p,version:p.version+1};
      const proposal=await submit(adm.token,input(updated,{priceIdr:160000,referenceDocument:undefined}));
      eq(proposal.status,201,"Admin boleh mengajukan tanpa rujukan");
      const id=String(proposal.body.requestId);
      const grant=await reauth(o.token,id,updated.version);
      eq(grant.status,201,"reauth");
      const token=String(grant.body.reauthToken),key=randomUUID();
      const blocked=await approve(o.token,id,updated.version,token,key);
      eq(blocked.status,400,"persetujuan tanpa rujukan ditolak");
      eq(blocked.body.code,"PRICE_REFERENCE_REQUIRED","kode rujukan wajib");
      const latest=(await prices(o.token,p.id)).body.packages as {packageId:string;current:{priceIdr:number}|null}[];
      eq(latest.find(v=>v.packageId===p.unit)?.current?.priceIdr,150000,"harga tetap sebelum ada rujukan");
      const ref="RAPAT-HARGA-02";
      const accepted=await approve(o.token,id,updated.version,token,key,ref);
      eq(accepted.status,200,"persetujuan dengan rujukan di body");
      const replay=await approve(o.token,id,updated.version,token,key,ref);
      eq(replay.status,200,"ulangi permintaan yang berhasil");
      eq(replay.body.ruleId,accepted.body.ruleId,"satu versi harga");
      eq(replay.body.replayed,true,"penanda replay");
      const [review]=await auditDetails(o.tenant,id,"PRICE_APPROVED");
      eq(review.detail.referenceDocument,ref,"rujukan dari body");
      eq(review.detail.selfSubmitted,false,"pengajuan Admin");
      const after=(await prices(o.token,p.id)).body.packages as {packageId:string;current:{priceIdr:number}|null}[];
      eq(after.find(v=>v.packageId===p.unit)?.current?.priceIdr,160000,"harga baru terbit");
      for(const owner of [free,o]){
        const own=await product(owner.token);
        const result=await approved(owner.token,own,{priceIdr:12500,referenceDocument:undefined});
        const [audit]=await auditDetails(owner.tenant,String(result.body.requestId),"PRICE_APPROVED");
        eq(audit.detail.referenceDocument,null,"rujukan opsional");
        eq(audit.detail.selfSubmitted,true,"pengajuan sendiri");
      }
      return "Admin: Rp150.000 tetap saat 400; dengan rujukan menjadi Rp160.000. 2 Owner FREE/PRO: Rp12.500 masing-masing tanpa rujukan";
    });

    await priceTest("PRICE-21","Harga berlaku per kemasan dan penanda versi pengajuan",async({o,adm})=>{
      const p=await product(o.token);
      await approved(o.token,p,{packageId:p.box,priceIdr:150000});
      const second={...p,version:p.version+1};
      const old=await submit(adm.token,input(second,{packageId:p.box,priceIdr:151000}));
      eq(old.status,201,"pengajuan yang akan menjadi basi");
      await approved(o.token,second,{packageId:p.box,priceIdr:155000});
      const fresh=await submit(adm.token,input({...second,version:second.version+1},{packageId:p.box,priceIdr:156000}));
      eq(fresh.status,201,"pengajuan segar");
      const list=await prices(o.token,p.id);
      eq(list.status,200,"daftar harga");
      const packs=list.body.packages as {packageId:string;current:{priceIdr:number}|null}[];
      eq(packs.length,2,"dua kemasan aktif");
      eq(packs.find(v=>v.packageId===p.box)?.current?.priceIdr,155000,"harga terbaru");
      eq(packs.find(v=>v.packageId===p.unit)?.current,null,"kemasan lain belum berharga");
      const requests=list.body.requests as {id:string;state:string;stale:boolean}[];
      eq(requests.find(q=>q.id===old.body.requestId)?.stale,true,"usulan Rp151.000 basi");
      eq(requests.find(q=>q.id===fresh.body.requestId)?.stale,false,"usulan Rp156.000 segar");
      const approvals=requests.filter(q=>q.state==="APPROVED");
      eq(approvals.length,2,"dua harga pernah disetujui");
      ok(approvals.every(q=>q.stale===false),"pengajuan yang telah diputuskan tidak ditandai basi");
      return "Karton Rp150.000 menjadi Rp155.000; unit null; usulan Rp151.000 basi dan Rp156.000 segar";
    });

    await priceTest("PRICE-22","Database menolak body pengajuan yang tidak sah",async({o,adm})=>{
      const p=await product(o.token);
      const valid=input(p);
      const invalid=[
        {...valid,unrecognized:true},{...valid,expectedVersion:undefined},
        input(p,{priceIdr:1.25}),input(p,{priceIdr:"12500"}),input(p,{priceIdr:-1}),
        input(p,{priceIdr:1_000_000_000_000_001}),input(p,{expectedVersion:"1"}),
        input(p,{reason:" \t\n"}),input(p,{referenceDocument:"  "}),input(p,{productId:"invalid"}),
      ];
      for(const body of invalid){
        eq(await errOf(asActor(adm.token,"select app.price_submit($1,$2::jsonb)",[randomUUID(),body])),
          "VALIDATION","body ditolak database: "+JSON.stringify(body));
      }
      eq(await rows("select count(*)::int n from biz.price_change_request where tenant_id=$1",[o.tenant]),0,"tidak ada pengajuan");
      eq(await rows("select count(*)::int n from biz.idempotency where tenant_id=$1 and operation='price.request'",[o.tenant]),0,"tidak ada kunci terpakai");
      return "10 body ditolak VALIDATION oleh database; 0 pengajuan dan 0 kunci terpakai";
    });

    await priceTest("PRICE-23","Rp0 membutuhkan alasan dan ditandai di respons serta audit",async({o})=>{
      const p=await product(o.token);
      const invalid=await submit(o.token,input(p,{priceIdr:0,reason:"  "}));
      eq(invalid.status,400,"Rp0 tanpa alasan tidak boleh diajukan");
      const zero=await approved(o.token,p,{priceIdr:0,reason:"Sampel gratis",referenceDocument:undefined});
      eq(zero.body.zeroPrice,true,"respons Rp0");
      const [zeroAudit]=await auditDetails(o.tenant,String(zero.body.requestId),"PRICE_APPROVED");
      eq(zeroAudit.detail.zeroPrice,true,"audit Rp0");
      const standard=await approved(o.token,{...p,version:p.version+1},{priceIdr:150000});
      eq(standard.body.zeroPrice,false,"respons Rp150.000");
      const [standardAudit]=await auditDetails(o.tenant,String(standard.body.requestId),"PRICE_APPROVED");
      eq(standardAudit.detail.zeroPrice,false,"audit Rp150.000");
      return "Rp0 tanpa alasan ditolak 400; Rp0 dengan alasan 200 dan zeroPrice=true; Rp150.000 zeroPrice=false";
    });
  }finally{
    await app.close();await db.close();
  }
}
