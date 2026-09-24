"use client";

import styles from "./AudioControls.module.css";

export interface AudioControlsProps {
  musicVolume: number;
  soundVolume: number;
  onMusicVolumeChange: (value: number) => void;
  onSoundVolumeChange: (value: number) => void;
}

export default function AudioControls({
  musicVolume,
  soundVolume,
  onMusicVolumeChange,
  onSoundVolumeChange,
}: AudioControlsProps) {
  return (
    <div className={styles.controls} role="group" aria-label="Audio volume controls">
      <label className={styles.control}>
        <span>Music</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={musicVolume}
          aria-label="Music volume"
          onChange={(event) => onMusicVolumeChange(Number(event.currentTarget.value))}
        />
        <output>{musicVolume}%</output>
      </label>
      <label className={styles.control}>
        <span>SFX</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={soundVolume}
          aria-label="SFX volume"
          onChange={(event) => onSoundVolumeChange(Number(event.currentTarget.value))}
        />
        <output>{soundVolume}%</output>
      </label>
    </div>
  );
}
