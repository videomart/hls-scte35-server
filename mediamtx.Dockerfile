# A imagem oficial bluenviron/mediamtx é baseada em scratch, sem shell nem
# cliente HTTP -- precisamos de um binário para os hooks runOnAvailable/
# runOnUnavailable chamarem o scte-monitor (POST HTTP simples). O MediaMTX
# executa o comando via exec direto (sem shell), então basta o binário
# existir no PATH da imagem final.
FROM busybox:musl AS busybox

FROM bluenviron/mediamtx:latest
COPY --from=busybox /bin/busybox /bin/busybox
COPY --from=busybox /bin/busybox /bin/wget
