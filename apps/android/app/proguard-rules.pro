# Nekko Agent release rules.
#
# The protocol module decodes everything through kotlinx.serialization's
# JsonElement tree (no @Serializable classes), so no generated serializers need
# keeping; the library ships its own consumer rules for the runtime.
-keepattributes *Annotation*, InnerClasses, Signature

# OkHttp: optional TLS providers it probes for at runtime (recommended rules).
-dontwarn okhttp3.internal.platform.**
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

# Credential Manager finds its Play services provider by reflection (the rule
# from the androidx.credentials setup guide); without it a release build has no
# provider on Android 13 and below and step-up with a key always fails.
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** {
  *;
}
