import type { JobErrorCode } from "@clipclap/shared";
import type { Dict } from "./types";

/** Indonesian marks no grammatical plural: `Intl.PluralRules("id").select()`
 *  returns "other" for every count, so nouns are written once and no plural
 *  helper is needed here. That is the reason this file, unlike the others,
 *  imports no `plural` - not an oversight. */

const idFailure: Record<JobErrorCode, string> = {
  UNSUPPORTED_INPUT:
    "File ini tidak punya track video, hanya suara. Kirim file video dan aku akan memotongnya.",
  ANALYSIS_UNAVAILABLE:
    "Aku tidak bisa menentukan momen mana yang perlu dipotong dari video ini, dan menitmu tidak terpakai. Belum bisa dipastikan apakah yang ini akan selesai: tunggu beberapa menit untuk melihat apakah klipnya datang sebelum mengirim ulang, supaya video yang sama tidak menghabiskan menitmu dua kali. Kalau tidak ada yang datang, kirim lagi atau coba file lain.",
  SOURCE_UNAVAILABLE:
    "Aku tidak bisa mengunduh video dari tautan itu: mungkin privat, dibatasi wilayah, sudah dihapus, atau sedang tidak tersedia. Pastikan tautannya terbuka di browser, atau kirim filenya langsung ke sini. Menitmu tidak terpakai.",
  SOURCE_TOO_LARGE:
    "Video itu melebihi batas 2 GB, jadi aku tidak bisa mengunduhnya. Menitmu tidak terpakai. Mengirim filenya juga tidak membantu karena batas 2 GB-nya sama: potong dulu videonya ke bagian yang kamu mau, lalu kirim bagian itu.",
  FREE_ALLOWANCE_EXCEEDED:
    "Video ini lebih panjang dari sisa menit gratismu, jadi aku berhenti sebelum memprosesnya. Menit gratismu masih utuh: pakai untuk video yang lebih pendek, atau pilih paket untuk memproses yang ini sepenuhnya.",
};

const idFailureGeneric =
  "Ada yang salah saat memproses video ini dan menitmu tidak terpakai. Belum bisa dipastikan apakah yang ini akan selesai: tunggu beberapa menit untuk melihat apakah klipnya datang sebelum mengirim ulang, supaya video yang sama tidak menghabiskan menitmu dua kali. Kalau tidak ada yang datang, kirim lagi atau coba file lain.";

const id: Dict = {
  welcomeFirstScreen:
    "Halo! Kirim aku video panjang - atau tautannya - dan aku potong jadi klip vertikal bersubtitle, siap untuk TikTok, Reels, dan Shorts.\n\nCocok untuk podcast, siaran Twitch, wawancara, webinar, dan review.\n\nVideo pertamamu gratis: tanpa kartu, tanpa paket. Kalau hasilnya tidak ada klip, itu tidak dihitung.",
  welcomeBack: "Senang kamu kembali! Kirim video dan aku buatkan klipnya.",
  menuTitle: "Menu utama",
  welcomeNeedsPlan:
    "Kirim video dan aku buatkan klipnya. Akun baru dapat satu percobaan gratis: tanpa kartu, sampai 15 menit video.",
  // Appended by the handler to the onboarding screens, and only while
  // freeBudgetStatus() reports the month's ceiling closed. See the note on
  // freeRunsPausedNote in types.ts for why the promise above is left intact
  // rather than rewritten.
  freeRunsPausedNote:
    "⏳ Sebelum mulai: percobaan gratis dijeda sampai tanggal 1 bulan depan. Itu batas dari sisiku, bukan dari akunmu - menit gratismu tetap menunggumu. Kalau mau klip hari ini, buka 💳 Paket.",
  linkAccountInstructions: (code, url) =>
    `Kode penghubungmu: ${code}\n\n1. Buka ${url}/dashboard/settings di perangkat tempat kamu sudah login.\n2. Tempel kode ini dalam 10 menit.\n\nTelegram ini akan terhubung ke akun tersebut.`,
  callbackAck: "Oke",
  linkCodePrompt: (code, url) =>
    `Kode penghubungmu: ${code}\n\nBuka ${url}/dashboard/settings, tempel dalam 10 menit, dan Telegram-mu akan terhubung ke akun ClipClap-mu.`,
  linkSuccess: (n) =>
    n > 0
      ? `Telegram terhubung. ${n} klip dari riwayat bot sudah dipindahkan.`
      : "Telegram terhubung ke akunmu.",
  linkAlready: "Telegram ini sudah terhubung ke akunmu.",
  linkInvalid: "Kode penghubung tidak valid.",
  linkExpired:
    "Kode penghubung sudah kedaluwarsa. Buat yang baru di clipclap.io/dashboard/settings.",
  linkConflict:
    "Akun ClipClap-mu sudah terhubung ke Telegram lain. Putuskan dulu lewat situsnya.",
  linkWrongDirection:
    "Kode ini tidak bisa dipakai di sini. Pakai /link untuk membuat kode baru bagi Telegram ini.",
  sendVideoHint:
    "Kirim video dan aku ubah jadi klip vertikal. Pakai /start untuk mulai.",
  uploading: "Mengunggah videomu...",
  queued: "Masuk antrean. Klipnya aku kirim ke sini begitu render selesai.",
  progressTitle: "🎬 Sedang mengerjakan videomu",
  progressQueuedNote: "Dalam antrean - segera mulai.",
  progressStepDownload: "Mengambil videonya",
  progressStepTranscribe: "Mendengarkan suaranya",
  progressStepAnalyze: "Mencari momen terbaik",
  progressStepRender: "Memotong dan menambahkan subtitle",
  fileTooLarge: (url) =>
    `Video ini lebih dari 20 MB, batas Bot API Telegram. Untuk sekarang, unggah video panjang lewat situs: ${url}/dashboard. Kami sedang berusaha menghapus batas ini.`,
  processingFailed: (code) => (code && idFailure[code]) || idFailureGeneric,
  freeTrimNote: (clippedMinutes, sentMinutes) =>
    `Menit gratismu menutupi ${clippedMinutes} menit pertama dari ${sentMinutes} menit yang kamu kirim, jadi klip di atas berasal dari bagian itu saja. Jatah gratismu habis di situ. Untuk memproses sisanya, buka 💳 Paket.`,
  done: (n) => `Selesai. ${n} klip sudah siap.`,
  donePartial: (sent, total) =>
    `Terkirim ${sent} dari ${total} klip: sisanya tidak lolos. Tekan tombol di bawah, nanti aku coba lagi.`,
  resendRemainingBtn: "Kirim sisanya",
  deliveryGivenUp: (url, clips) => {
    if (clips === 0) {
      return `Aku tidak bisa mengirim hasil video ini ke chat ini dan berhenti mencoba. Dari sisiku tidak ada yang hilang. Jangan kirim video ini lagi sebelum kamu dapat kabar, karena memprosesnya sekali lagi akan memakai menitmu dua kali. Hubungi dukungan lewat menu bantuan, nanti aku ceritakan bagaimana akhirnya.`;
    }
    return `${clips === 1 ? "Klipmu sudah siap" : `Semua ${clips} klipmu sudah siap`}, tapi aku tidak bisa mengirimnya ke chat ini dan berhenti mencoba. Tidak ada yang hilang: hubungi dukungan lewat menu bantuan, nanti aku kirimkan ke kamu. Jangan kirim video ini lagi, karena klipnya sudah ada dan memprosesnya sekali lagi akan memakai menitmu dua kali.`;
  },
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Selesai, tapi aku tidak menemukan ucapan yang bisa dipakai di video ini: kali ini tidak ada klip."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Selesai, tapi sebagian video tidak bisa diproses dan di sisanya tidak ada momen yang kuat."
        : "Selesai. Aku menonton seluruh videonya, tapi tidak menemukan momen yang cukup kuat untuk dijadikan klip. Coba video dengan lebih banyak obrolan, emosi, atau cerita.",
  lowQualityNote:
    "Catatan: tidak ada momen yang kuat, ini yang terbaik dari yang ada.",
  blocked: (reason) => `${reason}\n\n💳 Paket: pilih atau kelola langgananmu.`,
  freeExhausted: (remainingMinutes, lifetimeMinutes, planMinutes, planPriceEur) =>
    `Menit gratismu tidak cukup untuk ini: sisa ${remainingMinutes} dari ${lifetimeMinutes}. Klip yang sudah jadi tetap milikmu.\n\nUntuk lanjut: Starter €${planPriceEur} per minggu, isinya ${planMinutes} menit video, sumber sampai 3 jam, dan 20 klip yang disimpan 7 hari.`,
  freeNotAnchored: (planMinutes, planPriceEur) =>
    `Menit gratis belum aktif di akun ini. Hubungi dukungan lewat menu bantuan dan aku bantu beresin, atau mulai sekarang dengan Starter: €${planPriceEur} per minggu untuk ${planMinutes} menit video.`,
  freeBudgetClosed: (planMinutes, planPriceEur) =>
    `Percobaan gratis dijeda sampai tanggal 1 bulan depan. Itu batas dari sisiku, bukan dari akunmu - menit gratismu tetap utuh.\n\nKalau mau memotong sekarang, Starter €${planPriceEur} per minggu untuk ${planMinutes} menit video.`,
  freeSourceTooLong: (freeMaxMinutes, planMaxMinutes) =>
    `Percobaan gratis menerima video sampai ${freeMaxMinutes} menit, dan yang ini lebih panjang. Kirim video yang lebih pendek, atau potongan ${freeMaxMinutes} menit dari video ini, untuk mencobanya gratis. Dengan paket, aku menerima sumber sampai ${planMaxMinutes} menit.`,
  planSourceTooLong: (maxMinutes) =>
    `Video ini lebih dari ${maxMinutes} menit, dan itu sumber terpanjang yang bisa aku terima. Kirim potongan yang lebih pendek dan aku proses.`,
  sourceTooShort:
    "Video ini kurang dari satu menit. Aku memotong klip dari obrolan yang panjang - siaran langsung, podcast, wawancara, kuliah - dan di sini belum ada yang bisa dipotong. Kirim yang minimal satu menit; sepuluh menit ke atas hasilnya paling bagus.",
  shortSourceNotice:
    "Catatan: video ini kurang dari lima menit. Dari sumber pendek biasanya cuma keluar 0-2 klip - sepuluh menit ke atas adalah tempat aku bekerja paling baik.",
  duplicateActive:
    "Aku sudah sedang mengerjakan video yang persis ini - aku kabari begitu selesai. Tidak perlu dikirim lagi.",
  duplicateDone: (clipCount) =>
    `Video ini sudah pernah kamu kirim - ini ${clipCount === 1 ? "klip yang" : `${clipCount} klip yang`} kubuat darinya, tanpa memakai menit.`,
  queuedBehind: (position) =>
    position <= 1
      ? "Diterima - aku masih mengerjakan videomu yang lain, jadi yang ini menunggu giliran: dia berikutnya dan mulai sendiri. Tidak perlu dikirim ulang."
      : `Diterima - aku masih mengerjakan videomu yang lain, jadi yang ini menunggu giliran: nomor ${position} dalam antrean. Mulai sendiri - tidak perlu dikirim ulang.`,
  planNotActive:
    "Tidak ada langganan aktif di akun ini, jadi aku belum bisa memproses video. Pilih paket dan aku langsung mulai.",
  planCanceled:
    "Langgananmu dibatalkan, jadi pemrosesan dimatikan. Berlangganan lagi dan semuanya lanjut dari tempat terakhir: klipmu masih ada.",
  planPeriodEnded:
    "Periode berbayarmu sudah berakhir, jadi pemrosesan dijeda. Perpanjang dan aku langsung kerjakan video ini.",
  planQuotaExceeded: (usedMinutes, limitMinutes, topUpMinutes) =>
    `Kamu sudah memakai ${usedMinutes} dari ${limitMinutes} menit di periode ini, dan video ini tidak muat di sisanya.${
      topUpMinutes > 0
        ? ` ${topUpMinutes} menit tambahanmu juga tidak cukup untuk video ini.`
        : ""
    } Tunggu periodenya diperbarui, tambah menit, atau naik ke paket yang lebih besar.`,
  planDailyLimit: (limit) =>
    `Kamu sudah mencapai batas harian ${limit} video. Batasnya direset tengah malam: kirim video ini lagi setelah itu.`,
  planConcurrentLimit: (active, limit) =>
    `Aku masih mengerjakan ${active === 1 ? "videomu" : `${active} videomu`}, dan paketmu memproses ${limit} sekaligus. Kirim yang ini lagi setelah selesai: nanti aku kabari.`,
  submitBusy:
    "Kiriman lain dari akunmu masih diproses. Tunggu sebentar lalu kirim ini lagi.",
  langUsage: (options) => `Cara pakai: ${options}.`,
  langSet: "Bahasa diatur ke Bahasa Indonesia.",
  langName: "Bahasa Indonesia",
  langBtn: "🇮🇩 Bahasa Indonesia",
  planStarterWeeklyBtn: "🌱 Starter - €3 / minggu",
  planStarterBtn: "💎 Starter - €9 / bulan",
  planPlusBtn: "🚀 Plus - €29 / bulan",
  planMaxBtn: "👑 Max - €89 / bulan",
  menuCreate: "🎬 Buat klip",
  createPrompt: ({ freeMaxMinutes, planMaxMinutes, maxFileGb }) =>
    `Kirim videonya - unggah file atau tempel tautan.\n\nSampai ${planMaxMinutes / 60} jam video, sampai ${maxFileGb} GB per file.${
      freeMaxMinutes === null
        ? ""
        : `\nDi percobaan gratis: sampai ${freeMaxMinutes} menit.`
    }`,
  menuAccount: "📊 Akun",
  menuHelp: "❓ Bantuan",
  menuSettings: "⚙️ Pengaturan",
  menuEarn: "💰 Cari uang",
  menuPlans: "💳 Paket",
  earnMenuPrompt: "💰 Cari uang - pilih:",
  earnReferralBtn: "🔗 Program referral",
  earnAdvertisersBtn: "🎯 Cari pengiklan",
  earnAdvertisersSoon:
    "🎯 Cari pengiklan\n\nKalau kamu punya audiens tapi belum ada pengiklan, aku bisa mencarikannya. Aku hanya ambil persentase dari kesepakatan yang aku temukan.\n\nBelum dibuka: masih aku siapkan. Aku juga menghitung berapa orang yang menekan ini, jadi menekannya adalah suara.",
  plansText:
    "💳 <b>Paket ClipClap</b>\nBayar sekali, langsung pakai. Batalkan kapan saja di Tribute.\n\n" +
    "🌱 <b>Starter</b> - €3/mgg · €9/bln\n   • 75 mnt/mgg (270 mnt/bln)\n   • 20 klip tersimpan\n   • disimpan 7 hari\n\n" +
    "🚀 <b>Plus</b> - €29/bln\n   • 1000 mnt/bln\n   • 150 klip\n   • disimpan 30 hari\n\n" +
    "👑 <b>Max</b> - €89/bln\n   • 3500 mnt/bln\n   • 1000 klip\n   • disimpan 90 hari\n   • ⚡ antrean prioritas\n\n" +
    "Pilih paket di bawah 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `Kamu di paket ${plan} ✅ Aktif sampai ${periodEnd}.\nKelola atau batalkan langgananmu di Tribute.`
      : `Kamu di paket ${plan} ✅\nKelola atau batalkan langgananmu di Tribute.`,
  noPlanNudge: "👉 Ketuk 💳 Paket untuk berlangganan.",
  helpText: (url) =>
    `Kirim video dan aku potong jadi klip vertikal bersubtitle.\nKamu juga bisa menempel tautan (YouTube, Twitch, TikTok, Vimeo, X, dan lainnya).\n\nBatas: sumber sampai 3 jam, file sampai 2 GB.\n\nPerintah:\n• /start - menu utama\n• /link - hubungkan akun clipclap.io\n• /referral - tautan referal dan penghasilanmu\n• /lang - ganti bahasa\n\nSitus: ${url}/dashboard`,
  helpMenuPrompt: "❓ Bantuan: pilih",
  helpHowBtn: "❓ Cara kerjanya",
  helpSupportBtn: "💬 Dukungan",
  supportPrompt:
    "Tulis pesanmu: kami teruskan ke tim dukungan dan membalas di sini juga.",
  supportCloseBtn: "⬅️ Tutup chat",
  supportClosed: "Chat ditutup. Kirim video kapan saja untuk membuat klip.",
  supportReplyPrefix: "💬 Dukungan:",
  supportUnavailable:
    "Dukungan sedang tidak tersedia. Coba lagi nanti.",
  supportVideoInSession:
    '⚠️ Kamu sedang berada di chat dukungan.\n\n• Untuk membuat klip, ketuk "⬅️ Tutup chat" di bawah lalu kirim videonya lagi.\n• Untuk menjelaskan masalahmu, kirim teks atau tangkapan layar.',
  supportMediaUnsupported:
    "Tidak bisa mengirim itu. Kirim tangkapan layar atau jelaskan lewat teks.",
  accountText: ({
    plan,
    billingCycleLabel,
    periodEnd,
    daysUntilPeriodEnd,
    phase,
    minutesUsed,
    minutesLimit,
    topUpMinutes,
    clipsStored,
    storageClipsLimit,
    retentionDays,
    clipsTotal,
  }) => {
    if (plan === "NONE" || phase === "NONE") {
      return `Paket: tidak ada yang aktif\n\nPilih paket untuk mulai membuat klip.\nTotal klip dibuat: ${clipsTotal}`;
    }
    const planLabel = `${plan}${billingCycleLabel ? ` (${billingCycleLabel})` : ""}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Paket: ${planLabel} - berakhir${periodEnd ? ` ${periodEnd}` : ""}`;
      renewLine = "Perpanjang untuk terus membuat klip.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Paket: ${planLabel} - dibatalkan`;
      renewLine = "Berlangganan lagi untuk terus membuat klip.";
    } else {
      planLine = `Paket: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (hari ini)"
            : ` (dalam ${daysUntilPeriodEnd} hari)`;
      renewLine = periodEnd ? `Diperpanjang: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Ada masalah pembayaran: perbarui metode pembayaranmu.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Menit: ${minutesUsed} / ${minutesLimit} periode ini (sisa ${minutesLeft})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ Menit tambahan: ${topUpMinutes}\n` : "";
    const storageLine = `Penyimpanan: ${clipsStored} / ${storageClipsLimit} klip (disimpan ${retentionDays} hari)`;
    const totalLine = `Total klip dibuat: ${clipsTotal}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(
      /\n\n\n+/g,
      "\n\n"
    );
  },
  planNone: "tidak ada paket aktif",
  settingsMenuPrompt: "⚙️ Pengaturan",
  settingsLangBtn: "🌐 Bahasa",
  settingsVideoBtn: "🎬 Pengaturan video",
  settingsLinkBtn: "🔗 Hubungkan akun",
  settingsBackBtn: "⬅️ Menu utama",
  langMenuPrompt: "Pilih bahasamu:",
  videoSettingsPrompt: "🎬 Pengaturan video",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Subtitle: aktif ✅" : "Subtitle: nonaktif ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Subtitle diaktifkan."
      : "Subtitle dinonaktifkan. Video baru tidak akan punya subtitle yang menempel.",
  // See the note on en.botDescription for why there is no plan, no price, no
  // limits and no "press START" line here.
  botDescription:
    "Ubah video panjang apa pun jadi klip viral pendek bersubtitle - siap untuk TikTok, Reels, dan Shorts!\n\nCocok untuk podcast, siaran Twitch, wawancara, webinar, dan review.\n\n1. Kirim video atau tempel tautan\n2. AI menemukan momen terbaik dan membuat klip\n3. Terima video siap posting langsung di sini, di Telegram\n\nVideo pertamamu gratis, tanpa kartu.",
  // See the note on en.botShortDescription. 120-char ceiling.
  botShortDescription:
    "Podcast, siaran, dan wawancara panjang → klip pendek viral bersubtitle untuk TikTok, Reels, dan Shorts.",
  commands: [
    { command: "start", description: "Menu utama" },
    { command: "account", description: "Paket dan statistikmu" },
    { command: "help", description: "Batas dan cara kerjanya" },
    { command: "settings", description: "Buka pengaturan" },
    { command: "lang", description: "Ganti bahasa" },
    { command: "link", description: "Hubungkan akun clipclap.io-mu" },
    { command: "referral", description: "Tautan referal dan penghasilanmu" },
  ],
  manageSubscriptionBtn: "🔧 Kelola langganan",
  checkingLink: "Memeriksa tautan…",
  urlAccessFailed:
    "Tidak bisa mengakses video di tautan itu. Coba tautan lain atau unggah filenya langsung.",
  urlYouTubeUnavailable:
    "Tautan YouTube sedang tidak berfungsi - yang memblokir adalah YouTube, bukan tautanmu, jadi tautan YouTube lain juga tidak akan membantu. Pemblokirannya datang dan pergi: coba kirim tautan yang sama lagi nanti, unggah file videonya langsung di sini, atau kirim tautan TikTok atau Twitch.",
  referralInfo: (web, tg, earned, pending) =>
    `Tautan referalmu:\nWeb: ${web}\nTelegram: ${tg}\n\nPenghasilan referal: $${earned}\nTertahan (14 hari): $${pending}`,
  referralWithdrawBtn: "💸 Ajukan penarikan",
  referralWithdrawStub: "Saldomu belum cukup untuk ditarik.",
  balanceInfo: (available, clearing) =>
    `Saldo dompet:\nTersedia: $${available}\nDiproses: $${clearing} (komisi masih tertahan 14 hari)`,
  payBtn: "💳 Bayar",
  checkoutReady: (plan) =>
    `Ketuk "Bayar" untuk berlangganan ${plan}. Kamu akan kembali ke bot setelah pembayaran.`,
  checkoutError: "Tidak bisa memulai pembayaran. Coba lagi sebentar lagi.",
  cycleWeekly: "mingguan",
  cycleMonthly: "bulanan",
  feedbackPrompt: "Mau posting ini?",
  feedbackVerdictAsIs: "Apa adanya",
  feedbackVerdictEdit: "Perlu diedit",
  feedbackVerdictNo: "Tidak",
  feedbackReasonBoring: "Momennya membosankan",
  feedbackReasonCutoff: "Terpotong",
  feedbackReasonFraming: "Wajah tidak terlihat",
  feedbackReasonSubs: "Subtitle salah",
  feedbackReasonQuality: "Kualitas buruk",
  feedbackThanks: "Terima kasih.",
  feedbackNoted: (reason: string) =>
    `Dicatat: ${reason}. Balas klip ini kalau mau menambahkan - saya baca.`,
  feedbackNoteSaved: "Oke, tersimpan untuk klip itu. Terima kasih.",
  feedbackNoteUnmatched:
    "Saya tidak bisa mengaitkan itu dengan klip. Pakai tombol di bawah klip untuk memberi tahu apa yang salah.",
};

export default id;
