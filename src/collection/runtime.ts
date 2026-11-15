import {posix,win32} from "node:path";

/** Pure resolution keeps previews usable without a Python installation or .env IO.
 * Explicit config wins over environment; a bare executable uses the process PATH.
 */
export function collectionPython(options:{python?:string;workspace?:string;platform?:NodeJS.Platform;env?:NodeJS.ProcessEnv}={}):string {
  const platform=options.platform??process.platform,path=platform==="win32"?win32:posix;
  const workspace=options.workspace??process.cwd();
  const configured=options.python??(options.env??process.env).COLLECTION_PYTHON;
  if(configured!==undefined&&configured!==""){
    if(!configured.trim()||/[\r\n\x00]/.test(configured))throw new Error("INVALID_COLLECTION_PYTHON");
    const value=configured.trim();
    return /[\\/]/.test(value)?path.resolve(workspace,value):value;
  }
  return path.resolve(workspace,".local-data","tools","mediacrawler-venv",...(platform==="win32"?["Scripts","python.exe"]:["bin","python"]));
}
