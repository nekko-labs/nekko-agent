// These fixtures execute Bash stubs and depend on POSIX paths, modes and symlinks.
// A bash.exe on Windows (often the WSL launcher) does not provide that filesystem.
// Do not probe for Bash and skip on failure: missing Bash on POSIX must still fail.
export function posixFixtureOptions(platform = process.platform) {
  return {
    skip: platform === 'win32'
      ? 'POSIX execution fixture: run with Linux/macOS Node (Linux CI runs this case)'
      : false,
  };
}

export const posixFixture = posixFixtureOptions();
