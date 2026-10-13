import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";

type FileDropOptions = {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
};

const isFileDrag = (event: DragEvent<HTMLElement>) =>
  Array.from(event.dataTransfer.types).includes("Files");

/** Shared boundary keeps nested previews and internal frame drags out of file import. */
export function useFileDrop({ disabled = false, onFiles }: FileDropOptions) {
  const depthRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const reset = useCallback(() => {
    depthRef.current = 0;
    setDragging(false);
  }, []);

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    depthRef.current += 1;
    setDragging(true);
  }, [disabled]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [disabled]);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    reset();
    if (files.length) onFiles(files);
  }, [disabled, onFiles, reset]);

  return { dragging, onDragEnter, onDragOver, onDragLeave, onDrop, reset };
}
