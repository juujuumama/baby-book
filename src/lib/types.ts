export type DateSource = 'exif' | 'manual';

export interface Photo {
  id: string;
  /** Local wall-clock time the photo was taken, "YYYY-MM-DDTHH:mm:ss", or null if unknown. */
  taken: string | null;
  dateSource: DateSource | null;
  /** Hints for photos without EXIF dates: file's modified time and any date in its name. */
  fileDate: string | null;
  nameDate: string | null;
  fileName: string;
  /** Stored full-size image dimensions (after orientation + downscale). */
  width: number;
  height: number;
  origWidth: number;
  origHeight: number;
  camera: string | null;
  dedupeKey: string;
  favorite: boolean;
  /** Set when a print of this photo has been matched while sorting. */
  printed?: boolean;
  addedAt: number;
}

export interface Settings {
  babyName: string;
  /** "YYYY-MM-DD" */
  birthDate: string;
}

export const DEFAULT_SETTINGS: Settings = { babyName: '', birthDate: '' };
