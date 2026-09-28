// Runs the markerless test over several scenarios and prints a summary table.
//   node test/run-free-matrix.mjs [--masks=rmbg|gt] [--quick]
import { execFileSync } from 'child_process';
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const masks = arg('masks', 'rmbg');
const extra = process.argv.slice(2).filter(a => !a.startsWith('--masks') && a !== '--quick');
const scenarios = [
    ['sneaker', 'walk', '25,45'], ['sneaker', 'walk', '35'], ['toy', 'walk', '25,45'], ['bottle', 'walk', '25,45'],
    ['sneaker', 'turntable', ''], ['toy', 'turntable', ''],
];
const rows = [];
for (const [obj, mode, loops] of process.argv.includes('--quick') ? scenarios.slice(0, 2) : scenarios) {
    const args = ['test/run-free.mjs', `--obj=${obj}`, `--mode=${mode}`, `--masks=${masks}`, '--n=30', ...(loops ? [`--loops=${loops}`] : []), ...extra];
    let out = '';
    try { out = execFileSync('node', args, { encoding: 'utf8', timeout: 900000 }); } catch (e) { out = (e.stdout || '') + (e.message || ''); }
    const g = (re) => (out.match(re) || [])[1];
    rows.push({
        scene: `${obj}/${mode}${loops ? '@' + loops + '°' : ''}`,
        reg: g(/registered (\d+\/\d+);/) || (out.includes('ERROR') ? 'FAIL' : '?'),
        posErr: g(/position err median ([\d.]+) mm/), rotErr: g(/rotation err median ([\d.]+)°/),
        focal: g(/focal est [\d.]+ vs true \d+ \(([-\d.]+) %\)/), ground: g(/ground error ([-\d.]+) mm/),
        iou: g(/^IoU ([\d.]+)/m), shape: g(/shape IoU \(size fitted[^)]*\): ([\d.]+)/), maskIoU: g(/mask IoU vs truth: mean ([\d.]+)/),
        time: g(/reconstruct=(\d+)/), hollow: g(/mug inside left empty: (\d+) %/), refine: g(/removedFrac":([\d.]+)/), maskMs: g(/ mask=(\d+)/), mem: g(/RSS ≈ (\d+) MB/),
    });
    console.log(out.split('\n').filter(l => /^==|ERROR|IoU|registered |focal|ground e|times/.test(l)).join('\n'));
}
console.log('\n| scene | registered | refine removed | mug hollow empty % | cam err mm | rot err ° | focal err % | ground err mm | IoU | shape IoU | mask IoU | masks ms | recon ms | peak RSS MB |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.scene} | ${r.reg} | ${r.refine ?? '-'} | ${r.hollow ?? '-'} | ${r.posErr ?? '-'} | ${r.rotErr ?? '-'} | ${r.focal ?? '-'} | ${r.ground ?? '-'} | ${r.iou ?? '-'} | ${r.shape ?? '-'} | ${r.maskIoU ?? '-'} | ${r.maskMs ?? '-'} | ${r.time ?? '-'} | ${r.mem ?? '-'} |`);
