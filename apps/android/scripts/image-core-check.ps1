# SDK-free image-chat check: uses only cached JVM jars. Never reads an Android SDK.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $HOME '.gradle/caches/modules-2/files-2.1'
$catalog = [IO.File]::ReadAllText((Join-Path $root 'gradle/libs.versions.toml'))
function Jar($group, $name) {
    $versionKey = if ($name -like 'kotlinx-coroutines-*') { 'coroutines' } elseif ($name -like 'kotlinx-serialization-*') { 'serialization' } elseif ($group -eq 'org.jetbrains.kotlin' -and $name -ne 'kotlin-reflect') { 'kotlin' } elseif ($name -eq 'okhttp-jvm') { 'okhttp' } elseif ($name -eq 'junit') { 'junit' } else { $null }
    $base = Join-Path $cache "$group/$name"
    if ($versionKey) {
        $version = [regex]::Match($catalog, "(?m)^$versionKey = `"([^`"]+)`"").Groups[1].Value
        $base = Join-Path $base $version
    }
    $jar = Get-ChildItem $base -Recurse -Filter '*.jar' | Sort-Object FullName | Select-Object -Last 1
    if (!$jar) { throw "Missing cached JVM dependency $group/$name" }
    return $jar.FullName
}
$compiler = @(
    (Jar 'org.jetbrains.kotlin' 'kotlin-compiler-embeddable'),
    (Jar 'org.jetbrains.kotlin' 'kotlin-stdlib'),
    (Jar 'org.jetbrains.kotlin' 'kotlin-script-runtime'),
    (Jar 'org.jetbrains.kotlin' 'kotlin-reflect'),
    (Jar 'org.jetbrains.kotlinx' 'kotlinx-coroutines-core-jvm'),
    (Jar 'org.jetbrains' 'annotations')
) -join ';'
$cp = @(
    (Jar 'org.jetbrains.kotlin' 'kotlin-stdlib'),
    (Jar 'org.jetbrains' 'annotations'),
    (Jar 'org.jetbrains.kotlinx' 'kotlinx-coroutines-core-jvm'),
    (Jar 'org.jetbrains.kotlinx' 'kotlinx-coroutines-test-jvm'),
    (Jar 'org.jetbrains.kotlinx' 'kotlinx-serialization-core-jvm'),
    (Jar 'org.jetbrains.kotlinx' 'kotlinx-serialization-json-jvm'),
    (Jar 'com.squareup.okhttp3' 'okhttp-jvm'),
    (Jar 'com.squareup.okio' 'okio-jvm'),
    (Jar 'junit' 'junit'),
    (Jar 'org.hamcrest' 'hamcrest-core')
) -join ';'
$out = Join-Path ([IO.Path]::GetTempPath()) ('nekko-image-core-' + [guid]::NewGuid())
New-Item -ItemType Directory $out | Out-Null
$main = Join-Path $root 'app/src/main/java/com/nekko/android'
$sources = @(Get-ChildItem (Join-Path $root 'protocol/src/main/kotlin') -Recurse -Filter '*.kt' | ForEach-Object FullName)
$sources += @('data/Models.kt','data/ModelChoice.kt','data/NewChatDefaults.kt','data/Remote.kt','data/SecureStore.kt','data/ComputersRepository.kt','data/AttentionState.kt','data/SignOutOutbox.kt','data/Outbox.kt','voice/VoiceTurn.kt','chat/ChatController.kt','chat/TurnSteps.kt','security/ChangeCalls.kt','previews/PreviewLoader.kt') | ForEach-Object { Join-Path $main $_ }
# Compile exact JVM portions of existing Android-backed storage sources in temp only.
# No Android storage implementation or UI is compiled or claimed verified by this check.
$phone = [IO.File]::ReadAllText((Join-Path $main 'data/PhonePrefs.kt'))
$phone = [regex]::Replace($phone, '(?m)^import (android\.|androidx\.).*\r?\n', '')
$phone = [regex]::Replace($phone, '(?s)class SharedPrefStore\(.*?\r?\n\}', '')
$phone = [regex]::Replace($phone, '(?m)^    constructor\(context: Context\).*\r?\n', '')
[IO.File]::WriteAllText((Join-Path $out 'PhonePrefsJvm.kt'), $phone)
$lists = [IO.File]::ReadAllText((Join-Path $main 'data/ChatListFiles.kt'))
$iface = [regex]::Match($lists, '(?s)interface ChatListCache \{.*?\r?\n\}').Value
[IO.File]::WriteAllText((Join-Path $out 'ChatListCacheJvm.kt'), "package com.nekko.android.data`nimport com.nekko.protocol.SavedChatList`n$iface`n")
$sources += (Join-Path $out 'PhonePrefsJvm.kt'), (Join-Path $out 'ChatListCacheJvm.kt')
$text = [IO.File]::ReadAllText((Join-Path $main 'util/Text.kt')).Split([string[]]@('@Composable'), [StringSplitOptions]::None)[0]
$text = [regex]::Replace($text, '(?m)^import (androidx\.|com\.nekko\.android\.R).*\r?\n', '')
[IO.File]::WriteAllText((Join-Path $out 'TextJvm.kt'), $text)
$sources += Join-Path $out 'TextJvm.kt'
$test = Join-Path $root 'app/src/test/java/com/nekko/android'
$sources += @('Fakes.kt','ImageChatControllerTest.kt','ImageChatRepositoryTest.kt','ChatControllerTest.kt','TurnStepsTest.kt','OutboxTest.kt','ChangeCallsTest.kt') | ForEach-Object { Join-Path $test $_ }
$sources += Join-Path $root 'protocol/src/test/kotlin/com/nekko/protocol/ImageChatTest.kt'
$argfile = Join-Path $out 'sources.txt'
$sources | ForEach-Object { '"' + $_.Replace('\','/') + '"' } | Set-Content $argfile
$java = Join-Path $env:JAVA_HOME 'bin/java.exe'
& $java -cp $compiler org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath $cp -d (Join-Path $out 'classes') "@$argfile"
if ($LASTEXITCODE -ne 0) { throw "SDK-free compilation failed; output: $out" }
$env:NEKKO_REPO_ROOT = (Resolve-Path (Join-Path $root '../..')).Path
& $java -cp ((Join-Path $out 'classes') + ';' + $cp) org.junit.runner.JUnitCore com.nekko.protocol.ImageChatTest com.nekko.android.ImageChatControllerTest com.nekko.android.ImageChatRepositoryTest com.nekko.android.ChatControllerTest com.nekko.android.TurnStepsTest com.nekko.android.OutboxTest com.nekko.android.ChangeCallsTest
if ($LASTEXITCODE -ne 0) { throw "Focused tests failed; output: $out" }
Write-Output "SDK-free image checks passed. Output: $out"
