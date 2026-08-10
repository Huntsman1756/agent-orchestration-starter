const visible = Object.keys(process.env).sort();
process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), environment_keys: visible })}\n`);
process.stderr.write('synthetic validation stderr\n');
