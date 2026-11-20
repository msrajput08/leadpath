import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
export function makeDb({through=5}={}) {
 const sql=new DatabaseSync(':memory:');
 const migrations=fs.readdirSync(new URL('../../db/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort();
 for(const file of migrations.slice(0,through))sql.exec(fs.readFileSync(new URL('../../db/migrations/'+file,import.meta.url),'utf8'));
 let tail=Promise.resolve();
 const db={sql,queries:0,prepare(query){const statement={sql:query,args:[],bind(...args){this.args=args;return this;},
  async first(){db.queries++;return sql.prepare(this.sql).get(...this.args)||null;},
  async all(){db.queries++;return {success:true,results:sql.prepare(this.sql).all(...this.args)};},
  async run(){db.queries++;const result=sql.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(result.changes)}};}
 };return statement;},batch(statements){
  const work=tail.then(async()=>{sql.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}});
  tail=work.catch(()=>{});return work;
 }};return db;
}
export function user(db,id=crypto.randomUUID()){
 const time=Date.now();db.sql.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,`${id}@example.test`,'Tester',time,time);return id;
}
export function monitor(db,uid,extra={}){
 const time=Date.now(),row={id:crypto.randomUUID(),user_id:uid,name:'Test monitor',webhook_ciphertext:'invalid-cipher',secret_hash:'hash',state:'active',health:'healthy',interval_seconds:21600,next_due:time-1,created_at:time,updated_at:time,verified_at:time,...extra};
 const keys=Object.keys(row);db.sql.prepare(`INSERT INTO monitors(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));return db.sql.prepare('SELECT * FROM monitors WHERE id=?').get(row.id);
}
export const context={waitUntil(p){p.catch(()=>{});}};
