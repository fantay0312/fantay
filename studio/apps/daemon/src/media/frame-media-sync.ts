/** Export-only video synchronization; the timeline and audio stay at exact t. */
export const MOTION_FRAME_MEDIA_SYNC = `
window.__odSeekMotionVideos = async function (time) {
  await Promise.all(Array.from(document.querySelectorAll('video[data-start]')).map(async function (video) {
    var start = Number(video.getAttribute('data-start') || 0);
    var duration = Number(video.getAttribute('data-duration') || video.getAttribute('data-play-duration'));
    var local = time - start;
    if (!Number.isFinite(start) || local < 0 || (Number.isFinite(duration) && local >= duration)) return;
    var mediaStart = Number(video.getAttribute('data-media-start') || 0);
    var rate = Number(video.getAttribute('data-playback-rate') || 1);
    if (!Number.isFinite(mediaStart) || !Number.isFinite(rate) || rate <= 0) throw new Error('Invalid video timing');
    if (video.readyState < 1) await new Promise(function (resolve, reject) {
      var timer;
      function clean() { clearTimeout(timer); video.removeEventListener('loadedmetadata', done); video.removeEventListener('error', fail); }
      function done() { clean(); resolve(); }
      function fail() { clean(); reject(new Error('Video metadata could not be loaded')); }
      video.addEventListener('loadedmetadata', done, {once:true});
      video.addEventListener('error', fail, {once:true});
      timer = setTimeout(function () { clean(); reject(new Error('Video metadata timed out')); }, 10000);
    });
    // Native seek timestamps are quantized. An exact 41/30 seconds can land
    // at 1366666us, just before frame 41. Stay 100us inside the requested frame.
    var target = Math.max(0, mediaStart + local * rate + 0.0001);
    if (Number.isFinite(video.duration)) target = Math.min(target, Math.max(0, video.duration - 0.001));
    if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.00005) return;
    await new Promise(function (resolve, reject) {
      var timer;
      function clean() { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', fail); }
      function done() { clean(); resolve(); }
      function fail() { clean(); reject(new Error('Video frame could not be decoded')); }
      video.addEventListener('seeked', done, {once:true});
      video.addEventListener('error', fail, {once:true});
      timer = setTimeout(function () { clean(); reject(new Error('Video frame seek timed out')); }, 10000);
      try { video.currentTime = target; } catch (error) { clean(); reject(error); }
    });
  }));
};
`;
