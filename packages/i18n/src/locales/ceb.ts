import type { Resources } from '../types.js';

// TODO(native-review): whole file is a non-native Cebuano/Bisaya draft. Strings marked TODO are
// uncertain or still in English and need a Butuan/Caraga Bisaya speaker before launch.
export const ceb: Resources = {
  common: {
    appName: 'eBalangay',
    tagline: 'Need mo? eBalangay mo.',
    actions: {
      ok: 'OK',
      cancel: 'Kanselahon',
      save: 'I-save',
      retry: 'Sulayi pag-usab',
      back: 'Balik',
      next: 'Sunod',
      done: 'Human na',
      edit: 'I-edit',
      delete: 'Papasa',
      close: 'Sirad-i',
      confirm: 'Kumpirmaha',
      search: 'Pangita',
      seeAll: 'Tan-awa tanan',
      update: 'I-update karon',
    },
    state: {
      loading: 'Nag-load…',
      empty: 'Wala pay sulod diri.',
      offline: 'Offline ka. Basin daan na ang ubang impormasyon.',
      reconnecting: 'Nag-konektar pag-usab…', // TODO(native-review)
      error: 'Naay problema.',
    },
    money: {
      subtotal: 'Subtotal',
      deliveryFee: 'Bayad sa delivery',
      serviceFee: 'Service fee',
      discount: 'Diskwento',
      tip: 'Tip sa rider',
      total: 'Kinatibuk-an',
      free: 'Libre',
    },
    time: {
      minutes_one: '{{count}} minuto',
      minutes_other: '{{count}} minuto',
      openNow: 'Abli karon',
      closed: 'Sirado',
      opensAt: 'Moabli sa {{time}}',
    },
    quantity: 'Gidaghanon',
    ratingCount_one: '{{count}} rating',
    ratingCount_other: '{{count}} ka rating',
    forceUpdate: {
      title: 'Kinahanglan mag-update',
      body: 'Naay bag-ong bersyon sa eBalangay. Palihug i-update aron makapadayon.',
    },
  },
  auth: {
    phoneTitle: 'Ibutang ang imong mobile number',
    phoneHint: 'Mo-text mi og 6-digit nga code.',
    phoneLabel: 'Mobile number',
    sendCode: 'Ipadala ang code',
    otpTitle: 'Ibutang ang code',
    otpHint: 'Nagpadala mi og code sa {{phone}}.',
    otpLabel: '6-digit nga code',
    resendIn: 'Ipadala pag-usab sulod sa {{seconds}}s',
    resend: 'Ipadala pag-usab ang code',
    verify: 'I-verify',
    signOut: 'Mag-sign out',
    sessionExpired: 'Na-expire ang imong session. Palihug pag-sign in pag-usab.',
  },
  orders: {
    status: {
      pending_payment: 'Naghulat sa bayad',
      placed: 'Na-order na',
      confirmed: 'Gikumpirma sa tindahan',
      preparing: 'Giandam',
      ready: 'Andam na kuhaon',
      rider_assigned: 'Naa nay rider',
      rider_at_merchant: 'Naa na sa tindahan ang rider',
      picked_up: 'Nakuha na',
      on_the_way: 'Padulong na',
      rider_nearby: 'Duol na ang rider',
      delivered: 'Nahatod na',
      cancelled: 'Gikansela',
      failed: 'Wala madayon',
    },
    prep: {
      being_packed: 'Giputos',
      almost_ready: 'Hapit na mahuman',
      rider_called: 'Gitawag na ang rider',
    },
    actions: {
      accept: 'Dawata',
      reject: 'Isalikway', // TODO(native-review)
      markPreparing: 'Sugdi pag-andam',
      markReady: 'Markahi nga andam',
      cancel: 'Kanselahon ang order',
      track: 'I-track ang order',
      reorder: 'Order pag-usab',
      contactRider: 'I-message ang rider',
      contactStore: 'I-message ang tindahan',
    },
    orderCode: 'Order {{code}}',
    eta: 'Moabot sulod sa mga {{minutes}} minuto',
    itemCount_one: '{{count}} item',
    itemCount_other: '{{count}} ka item',
    cancelReason: 'Rason sa pagkansela',
    history: 'Kasaysayan sa order',
    empty: 'Wala pa kay order.',
  },
  catalog: {
    addToCart: 'Idugang sa cart',
    outOfStock: 'Hurot na',
    unavailable: 'Dili available',
    required: 'Kinahanglan',
    optional: 'Opsyonal',
    chooseUpTo_one: 'Pili hangtod {{count}}',
    chooseUpTo_other: 'Pili hangtod {{count}}',
    specialInstructions: 'Espesyal nga bilin', // TODO(native-review)
    searchPlaceholder: 'Pangita og tindahan ug item',
    categories: 'Mga kategorya',
    noResults: 'Walay resulta para sa "{{query}}".',
  },
  errors: {
    VALIDATION_FAILED: 'Naay kulang o sayop nga detalye.',
    UNAUTHENTICATED: 'Palihug pag-sign in aron makapadayon.',
    TOKEN_EXPIRED: 'Na-expire ang imong session. Palihug pag-sign in pag-usab.',
    FORBIDDEN: 'Wala kay access ani.',
    NOT_FOUND: 'Wala namo makit-i ang imong gipangita.',
    CONFLICT: 'Naay laing nag-usab ani. Palihug i-refresh ug sulayi pag-usab.',
    INVALID_TRANSITION: 'Dili na ma-update ang order sa ingon ani nga paagi.', // TODO(native-review)
    IDEMPOTENCY_CONFLICT: 'Gi-proseso na kini nga request.',
    OTP_INVALID: 'Sayop ang code.',
    OTP_EXPIRED: 'Na-expire na ang code. Pangayo og bag-o.',
    STORE_CLOSED: 'Sirado ang tindahan karon.',
    OUT_OF_STOCK: 'Hurot na ang pipila ka item.',
    OUT_OF_DELIVERY_ZONE: 'Wala pa mi nag-deliver niini nga address.',
    VOUCHER_INVALID: 'Dili magamit kini nga voucher.',
    INSUFFICIENT_BALANCE: 'Kulang ang balance sa wallet.',
    PAYMENT_FAILED: 'Wala molampos ang bayad. Sulayi pag-usab.',
    RATE_LIMITED: 'Daghan kaayo nga pagsulay. Paghulat kadiyot ug sulayi pag-usab.',
    UPGRADE_REQUIRED: 'Palihug i-update ang app aron makapadayon.',
    SERVICE_UNAVAILABLE: 'Temporaryong dili available. Sulayi pag-usab unya.',
    INTERNAL: 'Naay problema sa among sistema. Palihug sulayi pag-usab.',
    NETWORK: 'Walay internet. Susiha ang koneksyon ug sulayi pag-usab.',
  },
  notifications: {
    orderConfirmed: {
      title: 'Kumpirmado ang order',
      body: 'Giandam na sa {{store}} ang imong order.',
    },
    orderPickedUp: { title: 'Padulong na', body: 'Nakuha na sa rider ang imong order.' },
    riderNearby: {
      title: 'Duol na ang rider',
      body: 'Hapit na moabot ang imong order.',
      sms: 'eBalangay: Duol na ang imong rider dala ang order {{code}}.', // TODO(native-review)
    },
    orderDelivered: {
      title: 'Nahatod na',
      body: 'Enjoy! I-tap aron i-rate ang imong order.',
      sms: 'eBalangay: Nahatod na ang order {{code}}. Salamat!', // TODO(native-review)
    },
    codReminder: {
      title: 'Andama ang bayad',
      body: 'Padulong na ang rider dala ang order {{code}}. Palihug andama ang {{amount}} nga cash.', // TODO(native-review)
      sms: 'eBalangay: Padulong na ang rider dala ang order {{code}}. Palihug andama ang {{amount}} nga cash.', // TODO(native-review)
    },
    orderCancelled: { title: 'Gikansela ang order', body: 'Gikansela ang order {{code}}.' },
    newOrder: { title: 'Bag-ong order', body: 'Order {{code}}: {{count}} ka item.' },
    scheduledRelease: {
      title: 'Sugdi na ang pag-andam',
      body: 'Ang scheduled order {{code}} para sa {{time}}.',
    }, // TODO(native-review)
    scheduledUnconfirmed: {
      title: 'Naghulat ang scheduled order',
      body: 'Dawata ang scheduled order {{code}} (para sa {{time}}) kay kon dili, kanselahon kini.', // TODO(native-review)
    },
    subscriptionPlaced: {
      title: 'Na-order na ang balik-balik nga order',
      body: 'Naka-schedule ang imong balik-balik nga order gikan sa {{store}} sa {{time}}.', // TODO(native-review)
    },
    subscriptionSkipped: {
      title: 'Gilaktawan ang balik-balik nga order',
      body: 'Wala namo ma-order ang imong balik-balik nga order gikan sa {{store}} karon. Sunod: {{time}}.', // TODO(native-review)
    },
    replacementProposed: {
      title: 'Puli nga item',
      body: 'Gisugyot sa {{store}} ang {{item}} isip puli. I-tap aron dawaton o isalikway.',
    },
    chatMessage: { title: 'Bag-ong mensahe', body: '{{from}}: {{text}}' },
    jobOffer: { title: 'Bag-ong delivery', body: 'Pickup sa {{store}}. Kita: {{fee}}.' }, // TODO(native-review)
    staffInvite: {
      sms: 'Gidugang ka sa {{store}} sa eBalangay. Pag-sign in sa eBalangay Merchant app gamit kining numero.', // TODO(native-review)
    },
  },
};
