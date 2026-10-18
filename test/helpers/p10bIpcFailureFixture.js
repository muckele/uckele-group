// Narrow local Node IPC characterization. The error listener is a probe for
// an error emitted outside try/catch; production does not have that listener.
let caughtSynchronously = false, asynchronousErrorEvents = 0, callbackFailures = 0;
const report = () => {
  process.stdout.write(JSON.stringify({ caughtSynchronously, asynchronousErrorEvents, callbackFailures }) + '\n');
  process.exitCode = 1;
};
process.on('error', () => { asynchronousErrorEvents++; report(); });
process.once('disconnect', () => {
  try {
    if (process.argv[2] === 'callback') process.send({ synthetic: true }, error => { if (error) callbackFailures++; report(); });
    else process.send({ synthetic: true });
  } catch { caughtSynchronously = true; report(); }
});
process.send({ fixtureReady: true });
