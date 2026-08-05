declare module "adm-zip" {
  interface ZipEntry {
    isDirectory: boolean;
    entryName: string;
    getData(): Buffer;
  }

  class AdmZip {
    constructor(buffer?: Buffer);
    getEntries(): ZipEntry[];
    addFile(entryName: string, content: Buffer, comment?: string): void;
    addLocalFolder(localPath: string, zipPath?: string): void;
    toBuffer(): Buffer;
  }

  export default AdmZip;
}
