# SDK-free integration regression suite. Uses cached JVM jars only, never reads an Android SDK.
# Reuses the image suite's dependency/compiler setup so shared image changes are checked too.
$ErrorActionPreference = 'Stop'
$script = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'image-core-check.ps1'))
$script = $script.Replace("'Fakes.kt'", "'VoiceChatControllerTest.kt','VoiceChangeCallsTest.kt','Fakes.kt'")
$script = $script.Replace('$argfile =', @'
$voiceNames = @('VoiceConversation','VoiceCommands','VoiceSegmenter','HoldToTalk','VoiceRunner','VoiceListening','VoiceSpeech')
$sources += $voiceNames | ForEach-Object { Join-Path $main "voice/$_.kt" }
$voiceTests = @(Get-ChildItem (Join-Path $test 'voice') -Filter '*Test.kt')
$sources += $voiceTests | ForEach-Object FullName
$argfile =
'@)
$script = $script.Replace('org.junit.runner.JUnitCore com.nekko.protocol.ImageChatTest', 'org.junit.runner.JUnitCore @($voiceTests | ForEach-Object { "com.nekko.android.voice.$($_.BaseName)" }) com.nekko.android.VoiceChatControllerTest com.nekko.android.VoiceChangeCallsTest com.nekko.protocol.ImageChatTest')
$script = $script.Replace('SDK-free image checks passed.', 'SDK-free voice + shared-image regression checks passed.')
$script = $script.Replace('$PSScriptRoot', ("'" + $PSScriptRoot.Replace("'", "''") + "'"))
& ([scriptblock]::Create($script))
