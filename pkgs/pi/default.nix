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
  version = "0.84.3";

  platform =
    if stdenv.hostPlatform.isDarwin then
      if stdenv.hostPlatform.isAarch64 then "darwin-arm64" else "darwin-x64"
    else if stdenv.hostPlatform.isAarch64 then
      "linux-arm64"
    else
      "linux-x64";

  clipboardNativePackage =
    {
      darwin-arm64 = "clipboard-darwin-arm64";
      darwin-x64 = "clipboard-darwin-x64";
      linux-arm64 = "clipboard-linux-arm64-gnu";
      linux-x64 = "clipboard-linux-x64-gnu";
    }
    .${platform};

  clipboardNativeFile =
    {
      darwin-arm64 = "clipboard.darwin-arm64.node";
      darwin-x64 = "clipboard.darwin-x64.node";
      linux-arm64 = "clipboard.linux-arm64-gnu.node";
      linux-x64 = "clipboard.linux-x64-gnu.node";
    }
    .${platform};

  # `npm run build` hydrates provider model data by hitting every upstream model
  # API, which a sandboxed build cannot do. The published npm package for the
  # matching version ships the already-hydrated data, so drop that in and use
  # `build:offline`.
  modelData = fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${version}.tgz";
    hash = "sha256-nECvL0OVD46U57vNDBs1SPAAly2gDE+5wNBSnU19VDE=";
  };
in
buildNpmPackage (finalAttrs: {
  pname = "pi-coding-agent";
  inherit version;

  src = fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    tag = "v${finalAttrs.version}";
    hash = "sha256-fC9pKgP2qD61ae5d7iOqP8anl88J1N1Bq8X8+aAjA2A=";
  };

  npmDepsHash = "sha256-cDx28+c4bwtQpiy5+BCvZhZezoZb4WRqfZj2eoEeMbw=";

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

    mkdir -p $out/bin/node_modules/@mariozechner
    cp -r ../../node_modules/@mariozechner/clipboard $out/bin/node_modules/@mariozechner/
    cp -r ../../node_modules/@mariozechner/${clipboardNativePackage} $out/bin/node_modules/@mariozechner/
    cp ../../node_modules/@mariozechner/${clipboardNativePackage}/${clipboardNativeFile} \
      $out/bin/node_modules/@mariozechner/clipboard/
    chmod -R u+w $out/bin/node_modules

    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      mkdir -p $out/bin/native/darwin/prebuilds/${platform}
      cp ../tui/native/darwin/prebuilds/${platform}/darwin-modifiers.node \
        $out/bin/native/darwin/prebuilds/${platform}/
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
