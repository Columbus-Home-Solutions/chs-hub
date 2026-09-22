declare module "heic2any" {
  export default function heic2any(options: {
    blob: Blob;
    toType?: string;
    quality?: number;
  }): Promise<Blob | Blob[]>;
}

declare module "piexifjs" {
  const piexif: {
    ImageIFD: { DateTime: number };
    ExifIFD: { DateTimeOriginal: number; DateTimeDigitized: number };
    GPSIFD: {
      GPSLatitudeRef: number;
      GPSLatitude: number;
      GPSLongitudeRef: number;
      GPSLongitude: number;
    };
    dump: (data: Record<string, unknown>) => string;
    insert: (exif: string, jpeg: string) => string;
  };
  export default piexif;
}
