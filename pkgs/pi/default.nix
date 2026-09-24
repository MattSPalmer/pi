{
  lib,
  stdenv,
  buildNpmPackage,
  fetchFromGitHub,
  fetchurl,
  bun,
  nodejs_22,
}:
let
  version = "0.87.1";

  platform =
    if stdenv.hostPlatform.isDarwin then
      if stdenv.hostPlatform.isAarch64 then "darwin-arm64" else "darwin-x64"
    else if stdenv.hostPlatform.isAarch64 then
      "linux-arm64"
    else
      "linux-x64";

  # `npm run build` hydrates provider model data by hitting every upstream model
  # API, which a sandboxed build cannot do. The published npm package for the
  # matching version ships the already-hydrated data, so drop that in and use
  # `build:offline`.
  modelData = fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${version}.tgz";
    hash = "sha256-NbRDLyfMJmX4a+67mvajmxJRlwiDwwRL2L5PToxzHKA=";
  };
in
buildNpmPackage (finalAttrs: {
  pname = "pi-coding-agent";
  inherit version;

  src = fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    tag = "v${finalAttrs.version}";
    hash = "sha256-GUhlq6t+l6iiViOZ0bkV28v3ZDqcLvEwpZpYZ5JAyDk=";
  };

  # Refresh this with `nix build` when the upstream lockfile changes.
  npmDepsHash = "sha256-JBIYoP2vvRNz1HONNvDJ1U3c+nmCJ7/VgNthRTkrkIA=";

  nodejs = nodejs_22;

  nativeBuildInputs = [ bun ];

  # Matches upstream's `npm ci --ignore-scripts`; nothing pi needs is built by
  # install scripts, and some transitive dev deps try to compile native addons.
  npmFlags = [ "--ignore-scripts" ];

  postPatch = ''
    mkdir -p packages/ai/src/providers/data
    tar -xzf ${modelData} -C packages/ai/src/providers/data \
      --strip-components=4 package/dist/providers/data
  '';

  dontNpmBuild = true;
  dontNpmInstall = true;
  dontStrip = true;

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR"
    npm run build:offline

    # Bun only embeds worker scripts passed as explicit entrypoints, and cwd
    # bunfig autoload can crash the standalone binary before pi starts.
    ( cd packages/coding-agent
      bun build --compile --no-compile-autoload-bunfig \
        ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
        --outfile dist/pi
    )

    runHook postBuild
  '';

  # Layout mirrors scripts/build-binaries.sh, i.e. the upstream release archive:
  # pi resolves docs, themes, assets and native helpers relative to itself.
  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    pushd packages/coding-agent > /dev/null

    install -Dm755 dist/pi $out/bin/pi
    cp package.json README.md CHANGELOG.md $out/bin/
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm $out/bin/
    mkdir -p $out/bin/theme $out/bin/assets
    cp dist/modes/interactive/theme/*.json $out/bin/theme/
    cp dist/modes/interactive/assets/* $out/bin/assets/
    cp -r dist/core/export-html docs examples $out/bin/

    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      mkdir -p $out/bin/native/darwin/prebuilds/${platform}
      cp ../tui/native/darwin/prebuilds/${platform}/darwin-platform.node \
        $out/bin/native/darwin/prebuilds/${platform}/
    ''}

    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      mkdir -p $out/bin/native/linux/prebuilds/${platform}
      cp ../tui/native/linux/prebuilds/${platform}/linux-platform-x11.node \
        $out/bin/native/linux/prebuilds/${platform}/
    ''}

    popd > /dev/null

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    actual="$($out/bin/pi --version)"
    if [ "$actual" != "${finalAttrs.version}" ]; then
      echo "unexpected pi version: $actual" >&2
      exit 1
    fi

    runHook postInstallCheck
  '';

  meta = {
    description = "AI coding agent CLI";
    homepage = "https://github.com/earendil-works/pi";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = [
      "aarch64-darwin"
      "x86_64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
})
