const MODULE_ID = 'deck-of-many-more-things';

export const SOUND_VOLUME = 0.7;

/**
 * Fire-and-forget so audio can never stall or break play — a missing file or a
 * browser autoplay block should cost the sound, not the draw. Broadcasting is
 * on by default so the whole table hears it, not just the client that acted.
 */
export function playSound(src, { volume = SOUND_VOLUME, broadcast = true } = {}) {
  if (!src) return;
  try {
    const played = foundry.audio.AudioHelper.play(
      { src, volume, autoplay: true, loop: false }, broadcast);
    if (played?.catch) played.catch((e) => console.warn(`${MODULE_ID} | sound failed: ${src}`, e));
  } catch (e) {
    console.warn(`${MODULE_ID} | sound failed: ${src}`, e);
  }
}
