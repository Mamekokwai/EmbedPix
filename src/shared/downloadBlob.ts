interface DownloadLink {
  href: string;
  download: string;
  click: () => void;
}

export interface DownloadBlobDependencies {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  createLink: () => DownloadLink;
  defer: (callback: () => void) => void;
}

const browserDependencies: DownloadBlobDependencies = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  createLink: () => document.createElement("a"),
  defer: (callback) => window.setTimeout(callback, 0),
};

export function downloadBlob(blob: Blob, fileName: string, dependencies: DownloadBlobDependencies = browserDependencies): void {
  const url = dependencies.createObjectURL(blob);
  const link = dependencies.createLink();
  link.href = url;
  link.download = fileName;
  try {
    link.click();
  } finally {
    dependencies.defer(() => dependencies.revokeObjectURL(url));
  }
}
