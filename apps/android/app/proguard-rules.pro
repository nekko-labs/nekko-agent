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
