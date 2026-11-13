import {mkdirSync,readFileSync,statSync,truncateSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";

const SQLITE_BUSY=5,SQLITE_NOTADB=26;
/** The lock file is itself a database: BEGIN IMMEDIATE takes an OS-level lock that dies with the
 * holder, so a crash or reboot can never leave a permanent stale lock. The file is also never
 * deleted: between one holder closing its connection and unlinking, another acquirer can lock
 * the same path, and a third would then create and lock a fresh inode — two holders, two files,
 * no exclusion. Throws Error(locked) while another process holds it; the returned release
 * function only ends the transaction and closes the connection. */
export function acquireExclusiveLock(path:string,locked:string){
  mkdirSync(dirname(path),{recursive:true});
  const open=()=>{const db=new DatabaseSync(path);try{db.exec("BEGIN IMMEDIATE");return db;}catch(error){db.close();throw error;}};
  for(let attempt=0;attempt<3;attempt++){
    try{const db=open();return ()=>{try{db.exec("ROLLBACK");}finally{db.close();}};}
    catch(error){
      const code=(error as {errcode?:number}).errcode;
      if(code===SQLITE_BUSY)throw new Error(locked);
      if(code!==SQLITE_NOTADB)throw error;
      if(legacyLockHeld(path))throw new Error(locked);
      // A zero-byte file already is a valid empty database, so truncating a dead marker in place
      // hands every contender the same inode; unlinking here would reopen the deleted-inode race.
      try{truncateSync(path,0);}catch{/* the marker vanished with its owner; reopen instead */}
    }
  }
  throw new Error(locked);
}
/** Older versions left plain JSON markers behind; respect one while its recorded holder lives. */
function legacyLockHeld(path:string){
  let pid:unknown;
  try{pid=(JSON.parse(readFileSync(path,"utf8")) as {pid?:unknown}).pid;}catch{return false;}
  if(!Number.isInteger(pid)||(pid as number)<=0)return false;
  try{process.kill(pid as number,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return false;}
  // A live pid can still be a reused one: nothing started after the file appeared ever wrote it.
  try{
    const started=Date.parse(execFileSync("ps",["-o","lstart=","-p",String(pid)],{encoding:"utf8",windowsHide:true})),birth=statSync(path).birthtimeMs;
    if(Number.isFinite(started)&&birth>0)return started<=birth;
    return true;
  }catch{try{process.kill(pid as number,0);}catch{return false;}return true;}
}
