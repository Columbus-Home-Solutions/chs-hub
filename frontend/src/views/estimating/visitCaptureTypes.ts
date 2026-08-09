export interface VisitPhoto {
  id: string;
  thumb_url: string;
  original_url: string;
}

export interface VisitCaptureSharedProps {
  requestId: string;
  notes: string;
  onNotesInput: (value: string) => void;
  onNotesBlur: () => void;
  recording: boolean;
  transcribing: boolean;
  micDenied: boolean;
  voiceSupported: boolean;
  onDismissMicDenied: () => void;
  onToggleRecording: () => void;
  onOpenAppSettings: () => void;
  sketchCount: number;
  firstSketchId: string | null;
  sketchModalOpen: boolean;
  onOpenSketch: () => void;
  visitPhotos: VisitPhoto[];
  photoUploading: boolean;
  photoInputRef: { current: HTMLInputElement | null };
  onPhotosButtonClick: () => void;
  onVisitPhotosSelected: (files: FileList | null) => void;
  onViewPhoto: (photo: VisitPhoto) => void;
  onDeletePhoto: (photoId: string) => void;
  draftGenerating: boolean;
  draftError: string | null;
  hasGeneratedDraft: boolean;
  hasScopeDraft: boolean;
  onGenerateScopeDraft: () => void;
}
