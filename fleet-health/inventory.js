'use strict';
// Assigned routes, not inferred from whatever happens to be configured on a phone.
// Box 1: owner-approved October 6-7 route swap. Box 2: November 7 verified mapping.
const box1 = [199,200,201,202,204,205,207,167,168,169,188,189,190,191,192,193,194,196,197,198];
const routeOrder = [167,199,169,168,189,188,191,190,193,192,196,194,198,200,197,202,201,205,207,204];
const box2 = [183,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,213,214];
const devices = box1.map((n, i) => ({ id: `60-${n}`, name: `FLEET ${String(i+1).padStart(2,'0')}`, vlan:60, ip:`192.168.60.${n}`, port:8201+routeOrder.indexOf(n), timezone:null, locale:'en-US', expectedExit:null }))
  .concat(box2.map((n,i) => {
    const c = n===183 || n>=208;
    const b = !c && n>=201;
    return { id:`61-${n}`, name:`BOX 2 · ${String(i+1).padStart(2,'0')}`, vlan:61, ip:`192.168.61.${n}`, port:c?8303:b?8302:8301,
      timezone:c?'Europe/London':'America/Los_Angeles', locale:c?'en-GB':'en-US', expectedExit:c?'192.177.186.73':b?'142.252.141.119':'172.120.79.131' };
  })).map(d=>({...d, serial:`${d.ip}:5555`, proxy:`192.168.52.10:${d.port}`}));
const apps = [
  ['Google Play services','com.google.android.gms'], ['Google Play Store','com.android.vending'],
  ['YouTube Music','com.google.android.apps.youtube.music'], ['Gmail','com.google.android.gm'],
  ['Spotify','com.spotify.music'], ['YouTube','com.google.android.youtube'],
  ['TikTok','com.zhiliaoapp.musically'], ['TikTok (alternate)','com.ss.android.ugc.trill'],
  ['Firefox','org.mozilla.firefox'], ['Speech Recognition','com.google.android.tts']
].map(([name,pkg])=>({name,pkg,google:pkg.startsWith('com.google.')||pkg==='com.android.vending',core:['com.google.android.gms','com.android.vending'].includes(pkg)}));
module.exports={devices, apps};
