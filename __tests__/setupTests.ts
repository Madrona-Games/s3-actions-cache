const processStdoutWrite = process.stdout.write.bind(process.stdout);

// Core library will directly call process.stdout.write for commands
// We don't want :: commands to be executed by the runner during tests
process.stdout.write = ((str: string, encoding?: any, cb?: any) => {
  if (!new RegExp(/^::/).exec(String(str))) {
    return processStdoutWrite(str, encoding, cb);
  }
  return true;
}) as typeof process.stdout.write;
