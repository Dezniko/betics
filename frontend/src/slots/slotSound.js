// Gods of Power sound cues. Every cue is synthesised with Web Audio and plays through the shared
// master gain (audioSettings.js), so the one tap mute and the volume slider apply here too.
// Interface used by the slot page (SlotsApp.jsx / slotAnim.js):
//   spinLoopStart()           reels begin turning (looping whoosh); call spinLoopStop() when the last reel stops
//   spinLoopStop()
//   reelStop(index)           a reel has landed, index 0 to 4 (pitch rises a little per reel)
//   anticipation(on)          two scatters are down and the last reels still turn: tense riser on/off
//   scatter(count)            a vault door landed; count = how many are visible so far (1 to 5), rising chime
//   lineWin(tier)             a winning line is traced; tier 0 small, 1 nice, 2 big, 3 mega
//   coinShower(durationMs)    coins falling during a big win
//   vaultOpen()               free spins start: metal creak and boom
//   fanfare()                 free spins banner
//   retrigger()               extra free spins added
//   countTick(progress)       win amount counting up (0 to 1)
// Each cue returns nothing and never throws. When the audio engine is not unlocked yet, cues are skipped.
export function spinLoopStart() {}
export function spinLoopStop() {}
export function reelStop() {}
export function anticipation() {}
export function scatter() {}
export function lineWin() {}
export function coinShower() {}
export function vaultOpen() {}
export function fanfare() {}
export function retrigger() {}
export function countTick() {}
