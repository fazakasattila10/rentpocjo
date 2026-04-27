import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { Buffer } from 'buffer';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { useShareIntentContext } from 'expo-share-intent';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Image, Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

const GOOGLE_WEB_CLIENT_ID =
  '24821394196-lc1p2dkfl1grresm8ffp7obktivburlf.apps.googleusercontent.com';

const STORAGE_KEYS = {
  ITEMS: 'rentpoc_items_v1',
  GOOGLE_TOKEN: 'rentpoc_google_access_token_v1',
  GOOGLE_USER_EMAIL: 'rentpoc_google_user_email_v1',
  GMAIL_SENDERS: 'rentpoc_gmail_senders_v1',
};
type ProviderLogoKey = 'eon' | 'electrica' | 'hidroelectrica' | 'digi';
type DocKind = 'invoice' | 'receipt';
type SourceKind = 'local' | 'gmail';
type FilterMode = 'all' | 'paid' | 'unpaid';

type GmailAttachmentMeta = {
  attachmentId: string;
  filename: string;
  mimeType?: string;
  size?: number;
  partId?: string;
};

type StoredFile = {
  fileName: string;
  mimeType?: string;
  localUri: string;
  originalUri: string;
};

type Item = {
  id: string;
  source: SourceKind;
  kind: DocKind;
  title: string;
  paid: boolean;
  createdAt: string;

  // local doc mezők
  fileName?: string;
  mimeType?: string;
  localUri?: string;
  originalUri?: string;

  // receipt attach mezők
  receiptFileName?: string;
  receiptMimeType?: string;
  receiptLocalUri?: string;
  receiptOriginalUri?: string;

  // gmail mezők
  gmailMessageId?: string;
  gmailThreadId?: string;
  fromEmail?: string;
  subject?: string;
  gmailBodyHtml?: string;
  gmailBodyText?: string;
  gmailSnippet?: string;
  gmailAttachments?: GmailAttachmentMeta[];
  gmailDownloadedAttachmentUri?: string;
  gmailDownloadedAttachmentFileName?: string;
  gmailDownloadedAttachmentMimeType?: string;
  providerLogoKey?: ProviderLogoKey;
};

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getHeaderValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  headerName: string
) {
  if (!headers) return '';
  const hit = headers.find(
    (h) => (h.name || '').toLowerCase() === headerName.toLowerCase()
  );
  return hit?.value || '';
}

function extractEmail(rawFrom: string) {
  const match = rawFrom.match(/<([^>]+)>/);
  if (match?.[1]) return match[1].trim().toLowerCase();
  return rawFrom.trim().toLowerCase();
}

function subjectToKind(subject: string): DocKind {
  const s = subject.toLowerCase();

  if (
    s.includes('receipt') ||
    s.includes('bizonylat') ||
    s.includes('nyugta') ||
    s.includes('payment receipt')
  ) {
    return 'receipt';
  }

  return 'invoice';
}
function hasReceipt(item: Item) {
  return !!item.receiptLocalUri;
}
function looksInvoiceLike(subject: string) {
  const s = subject.toLowerCase();
  return (
    s.includes('invoice') ||
    s.includes('szamla') ||
     s.includes('onfirmare plat') ||
     s.includes('plata fact') ||
    s.includes('számla') ||
    s.includes('receipt') ||
    s.includes('factura') ||
    s.includes('bizonylat') ||
    s.includes('nyugta') ||
    s.includes('bill') ||
    s.includes('payment')
  );
}

function normalizeBase64(input: string) {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad === 0) return base64;
  return base64 + '='.repeat(4 - pad);
}

function decodeBase64UrlToUtf8(input?: string) {
  if (!input) return '';

  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded =
      normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

    return Buffer.from(padded, 'base64').toString('utf8');
  } catch (e) {
    console.log('decodeBase64UrlToUtf8 error', e);
    return '';
  }
}
function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHtmlDocument(title: string, html?: string, text?: string) {
  if (html && html.trim()) {
    return `
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, sans-serif;
              padding: 16px;
              color: #2d2416;
              background: #f4efe3;
              line-height: 1.45;
            }
            img { max-width: 100%; height: auto; }
            table { max-width: 100%; border-collapse: collapse; }
          </style>
        </head>
        <body>
          ${html}
        </body>
      </html>
    `;
  }

  return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            padding: 16px;
            color: #2d2416;
            background: #f4efe3;
            line-height: 1.45;
            white-space: pre-wrap;
          }
        </style>
      </head>
      <body>
        <h3>${escapeHtml(title)}</h3>
        <div>${escapeHtml(text || 'Nincs megjeleníthető tartalom.')}</div>
      </body>
    </html>
  `;
}
function detectProviderLogoKey(params: {
  subject?: string;
  fromEmail?: string;
  bodyHtml?: string;
  bodyText?: string;
}): Item['providerLogoKey'] {
  const haystack = [
    params.subject || '',
    params.fromEmail || '',
    params.bodyHtml || '',
    params.bodyText || '',
  ]
    .join(' ')
    .toLowerCase();

  if (haystack.includes('e.on') || haystack.includes('eon-romania')) {
    return 'eon';
  }

  if (
    haystack.includes('electrica furnizare') ||
    haystack.includes('electricafurnizare')
  ) {
    return 'electrica';
  }

  if (haystack.includes('hidroelectrica')) {
    return 'hidroelectrica';
  }

  if (
    haystack.includes('factura digi') ||
    haystack.includes('digi rom')
  ) {
    return 'digi';
  }

  return undefined;
}
function extensionFromMimeType(mimeType?: string) {
  switch ((mimeType || '').toLowerCase()) {
    case 'application/pdf':
      return 'pdf';
    case 'image/jpeg':
      return 'jpg';
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'text/plain':
      return 'txt';
    case 'text/html':
      return 'html';
    default:
      return 'bin';
  }
}

function isPreviewableAttachment(att?: GmailAttachmentMeta) {
  if (!att) return false;
  const mime = (att.mimeType || '').toLowerCase();
  return (
    mime === 'application/pdf' ||
    mime.startsWith('image/')
  );
}

function collectGmailParts(
  part: any,
  acc: {
    html: string[];
    text: string[];
    attachments: GmailAttachmentMeta[];
  }
) {
  if (!part) return;

  const mimeType = (part.mimeType || '').toLowerCase();
  const filename = part.filename || '';
  const body = part.body || {};

  // inline body
  if (body?.data) {
    const decoded = decodeBase64UrlToUtf8(body.data);

    if (decoded) {
      if (mimeType.includes('text/html')) {
        acc.html.push(decoded);
      } else if (mimeType.includes('text/plain')) {
        acc.text.push(decoded);
      } else if (!mimeType && !filename) {
        // fallback: néha nincs rendes mimeType
        acc.text.push(decoded);
      }
    }
  }

  // attachment meta
  if (body?.attachmentId && filename) {
    acc.attachments.push({
      attachmentId: body.attachmentId,
      filename,
      mimeType: part.mimeType,
      size: body.size,
      partId: part.partId,
    });
  }

  // nested parts
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectGmailParts(child, acc);
    }
  }
}


export default function Index() {
  const [providerFilter, setProviderFilter] = useState<ProviderLogoKey | null>(null);
  const insets = useSafeAreaInsets();
  const [shareModalVisible, setShareModalVisible] = useState(false);
const [sharedFile, setSharedFile] = useState<StoredFile | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [googleUserEmail, setGoogleUserEmail] = useState<string | null>(null);

  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [senderModalVisible, setSenderModalVisible] = useState(false);
  const [sender1, setSender1] = useState('');
const [sender2, setSender2] = useState('');
const [sender3, setSender3] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  const [receiptAttachModalVisible, setReceiptAttachModalVisible] = useState(false);
  const [pendingReceiptFile, setPendingReceiptFile] = useState<StoredFile | null>(null);

  const [emailPreviewVisible, setEmailPreviewVisible] = useState(false);
  const [emailPreviewTitle, setEmailPreviewTitle] = useState('');
  const [emailPreviewHtml, setEmailPreviewHtml] = useState('');

  const paidCount = useMemo(() => items.filter((x) => x.paid).length, [items]);
  const unpaidCount = useMemo(() => items.filter((x) => !x.paid).length, [items]);

  const filteredItems = useMemo(() => {
    let next = items;

    if (filterMode === 'paid') {
      next = next.filter((x) => x.paid);
    } else if (filterMode === 'unpaid') {
      next = next.filter((x) => !x.paid);
    }

    if (providerFilter) {
      next = next.filter((x) => x.providerLogoKey === providerFilter);
    }

    return next;
  }, [items, filterMode, providerFilter]);

  const unpaidInvoices = useMemo(
    () => items.filter((x) => x.kind === 'invoice' && !x.paid),
    [items]
  );

  useEffect(() => {
    GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      offlineAccess: false,
      forceCodeForRefreshToken: false,
    });

    bootstrap();
  }, []);

  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEYS.ITEMS, JSON.stringify(items)).catch(() => {});
  }, [items]);
  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;

   if (shareIntent.files && shareIntent.files.length > 0) {
      const file = shareIntent.files[0];

      const mapped: StoredFile = {
        fileName: file.fileName || `shared_${Date.now()}`,
        mimeType: file.mimeType,
        localUri: file.path,
        originalUri: file.path,
      };

      setSharedFile(mapped);
      setShareModalVisible(true);
    }
  }, [hasShareIntent, shareIntent]);
  const bootstrap = async () => {
    try {
      setLoading(true);

      const [savedItemsRaw, savedToken, savedEmail, savedSendersRaw] =
        await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.ITEMS),
          AsyncStorage.getItem(STORAGE_KEYS.GOOGLE_TOKEN),
          AsyncStorage.getItem(STORAGE_KEYS.GOOGLE_USER_EMAIL),
          AsyncStorage.getItem(STORAGE_KEYS.GMAIL_SENDERS),
        ]);

      if (savedItemsRaw) {
        setItems(JSON.parse(savedItemsRaw));
      }

      if (savedToken) setGoogleAccessToken(savedToken);
      if (savedEmail) setGoogleUserEmail(savedEmail);

      if (savedSendersRaw) {
        const parsed = JSON.parse(savedSendersRaw);
        setSender1(parsed.sender1 || '');
        setSender2(parsed.sender2 || '');
        setSender3(parsed.sender3 || '');
      }

      if (GoogleSignin.hasPreviousSignIn()) {
        try {
          const silent = await GoogleSignin.signInSilently();

          if (silent.type === 'success') {
            const tokens = await GoogleSignin.getTokens();
            const email = silent.data.user.email || null;

            setGoogleAccessToken(tokens.accessToken);
            setGoogleUserEmail(email);

            await AsyncStorage.multiSet([
              [STORAGE_KEYS.GOOGLE_TOKEN, tokens.accessToken],
              [STORAGE_KEYS.GOOGLE_USER_EMAIL, email || ''],
            ]);
          }
        } catch {
          // marad a mentett állapot
        }
      }
    } catch (error) {
      console.error(error);
      Alert.alert('Hiba', 'Nem sikerült betölteni a mentett adatokat.');
    } finally {
      setLoading(false);
    }
  };

const persistSenders = async (next1: string, next2: string, next3: string) => {
  await AsyncStorage.setItem(
    STORAGE_KEYS.GMAIL_SENDERS,
    JSON.stringify({
      sender1: next1.trim(),
      sender2: next2.trim(),
      sender3: next3.trim(),
    })
  );
};

  const ensureFolder = async (folderUri: string) => {
    const folderInfo = await FileSystem.getInfoAsync(folderUri);
    if (!folderInfo.exists) {
      await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });
    }
  };

  const pickAndCopyFileToAppStorage = async (folderName: string) => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });

    if (result.canceled) return null;

    const asset = result.assets?.[0];
    if (!asset?.uri) {
      Alert.alert('Hiba', 'Nem sikerült a fájl kiválasztása.');
      return null;
    }

    const folderUri = `${FileSystem.documentDirectory}${folderName}/`;
    await ensureFolder(folderUri);

    const fileName = asset.name || `file_${Date.now()}`;
    const safeFileName = fileName.replace(/[^\w.\-() ]/g, '_');
    const targetUri = `${folderUri}${Date.now()}_${safeFileName}`;

    await FileSystem.copyAsync({
      from: asset.uri,
      to: targetUri,
    });

    return {
      fileName: asset.name || safeFileName,
      mimeType: asset.mimeType || undefined,
      localUri: targetUri,
      originalUri: asset.uri,
    } satisfies StoredFile;
  };

  const addInvoice = async () => {
    try {
      const stored = await pickAndCopyFileToAppStorage('docs');
      if (!stored) return;

      const newItem: Item = {
        id: makeId('invoice'),
        source: 'local',
        kind: 'invoice',
        title: stored.fileName || 'Számla',
        paid: false,
        createdAt: new Date().toISOString(),
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        localUri: stored.localUri,
        originalUri: stored.originalUri,
      };

      setItems((prev) => [newItem, ...prev]);
    } catch (error) {
      console.error(error);
      Alert.alert('Hiba', 'Nem sikerült a számla mentése.');
    }
  };

  const addReceipt = async () => {
    try {
      if (unpaidInvoices.length === 0) {
        Alert.alert('Nincs nyitott számla', 'Nincs olyan unpaid számla, amihez csatolni lehetne a bizonylatot.');
        return;
      }

      const stored = await pickAndCopyFileToAppStorage('receipts');
      if (!stored) return;

      setPendingReceiptFile(stored);
      setReceiptAttachModalVisible(true);
    } catch (error) {
      console.error(error);
      Alert.alert('Hiba', 'Nem sikerült a bizonylat kiválasztása.');
    }
  };
const addReceiptToSpecificInvoice = async (invoiceId: string) => {
  try {
    const stored = await pickAndCopyFileToAppStorage('receipts');
    if (!stored) return;

    setItems((prev) =>
      prev.map((item) =>
        item.id === invoiceId
          ? {
              ...item,
              paid: true,
              receiptFileName: stored.fileName,
              receiptMimeType: stored.mimeType,
              receiptLocalUri: stored.localUri,
              receiptOriginalUri: stored.originalUri,
            }
          : item
      )
    );
  } catch (error) {
    console.error(error);
    Alert.alert('Hiba', 'Nem sikerült a bizonylat kiválasztása.');
  }
};
  const attachReceiptToInvoice = (invoiceId: string) => {
    if (!pendingReceiptFile) return;

    setItems((prev) =>
      prev.map((item) =>
        item.id === invoiceId
          ? {
              ...item,
              paid: true,
              receiptFileName: pendingReceiptFile.fileName,
              receiptMimeType: pendingReceiptFile.mimeType,
              receiptLocalUri: pendingReceiptFile.localUri,
              receiptOriginalUri: pendingReceiptFile.originalUri,
            }
          : item
      )
    );

    setPendingReceiptFile(null);
    setReceiptAttachModalVisible(false);
  };

  const cancelAttachReceipt = async () => {
    try {
      if (pendingReceiptFile?.localUri) {
        await FileSystem.deleteAsync(pendingReceiptFile.localUri, { idempotent: true });
      }
    } catch {
      // ignore
    } finally {
      setPendingReceiptFile(null);
      setReceiptAttachModalVisible(false);
    }
  };

  const togglePaid = (id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, paid: !item.paid } : item
      )
    );
  };

const openFileUri = async (localUri: string, mimeType?: string) => {
  const fileInfo = await FileSystem.getInfoAsync(localUri);
  if (!fileInfo.exists) {
    Alert.alert('Hiányzó fájl', 'A fájl már nem található.');
    return;
  }

  const contentUri = await FileSystem.getContentUriAsync(localUri);

  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: mimeType || '*/*',
    flags: 1 + 2,
  });
};

const openLocalFile = async (item: Item) => {
  try {
    if (!item.localUri) {
      Alert.alert('Hiba', 'Ehhez a tételhez nincs lokális fájl.');
      return;
    }

    await openFileUri(item.localUri, item.mimeType);
  } catch (error) {
    console.error(error);
    Alert.alert(
      'Megnyitás sikertelen',
      'A fájl megnyitása nem sikerült. Lehet, hogy nincs hozzá megfelelő app a készüléken.'
    );
  }
};
  const openReceiptFile = async (item: Item) => {
  try {
    if (!item.receiptLocalUri) {
      Alert.alert('Hiba', 'Ehhez a számlához nincs csatolt bizonylat.');
      return;
    }

    await openFileUri(item.receiptLocalUri, item.receiptMimeType);
  } catch (error) {
    console.error(error);
    Alert.alert('Hiba', 'A bizonylat megnyitása nem sikerült.');
  }
};

  const handleClearGmailItems = () => {
    Alert.alert(
      'Gmail lista törlése',
      'Biztosan törölni szeretnéd az emailből behúzott tételeket?',
      [
        { text: 'Mégse', style: 'cancel' },
        {
          text: 'Törlés',
          style: 'destructive',
          onPress: () => {
            setItems((prev) => prev.filter((x) => x.source !== 'gmail'));
          },
        },
      ]
    );
  };
  const handleGoogleLogin = async () => {
    try {
      setBusy(true);

      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: true,
      });

      const signInResponse = await GoogleSignin.signIn();

      if (!isSuccessResponse(signInResponse)) {
        return;
      }

      const tokens = await GoogleSignin.getTokens();
      const email = signInResponse.data.user.email || '';

      setGoogleAccessToken(tokens.accessToken);
      setGoogleUserEmail(email);

      await AsyncStorage.multiSet([
        [STORAGE_KEYS.GOOGLE_TOKEN, tokens.accessToken],
        [STORAGE_KEYS.GOOGLE_USER_EMAIL, email],
      ]);

      Alert.alert('Siker', `Google login kész${email ? `: ${email}` : ''}`);
    } catch (error) {
      console.error(error);

      if (isErrorWithCode(error)) {
        switch (error.code) {
          case statusCodes.SIGN_IN_CANCELLED:
            return;
          case statusCodes.IN_PROGRESS:
            Alert.alert('Folyamatban', 'A Google bejelentkezés már folyamatban van.');
            return;
          case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
            Alert.alert('Hiba', 'A Google Play Services nem elérhető ezen az eszközön.');
            return;
        }
      }

      Alert.alert('Hiba', 'Nem sikerült a Google bejelentkezés.');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleLogout = async () => {
    try {
      setBusy(true);

      await GoogleSignin.signOut();

      setGoogleAccessToken(null);
      setGoogleUserEmail(null);

      await AsyncStorage.multiRemove([
        STORAGE_KEYS.GOOGLE_TOKEN,
        STORAGE_KEYS.GOOGLE_USER_EMAIL,
      ]);
    } catch (error) {
      console.error(error);
      Alert.alert('Hiba', 'Nem sikerült a kijelentkezés.');
    } finally {
      setBusy(false);
    }
  };

  const fetchMessageFull = async (accessToken: string, messageId: string) => {
    const url =
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`messages.get full error ${res.status}: ${text}`);
    }

    return res.json();
  };

  const mapFullMessageToItem = (detail: any, messageRef: { id: string; threadId?: string }) => {
    
    const headers = detail.payload?.headers || [];

    const subject = getHeaderValue(headers, 'Subject') || '(nincs subject)';
    const rawFrom = getHeaderValue(headers, 'From');
    const fromEmail = extractEmail(rawFrom);

    const collected = {
      html: [] as string[],
      text: [] as string[],
      attachments: [] as GmailAttachmentMeta[],
    };
    console.log(
      'gmail payload debug',
      JSON.stringify(
        {
          mimeType: detail?.payload?.mimeType,
          hasBodyData: !!detail?.payload?.body?.data,
          partsCount: detail?.payload?.parts?.length || 0,
          snippet: detail?.snippet,
          subject,
        },
        null,
        2
      )
    );
    console.log('collected html/text', {
      htmlCount: collected.html.length,
      textCount: collected.text.length,
      attachmentsCount: collected.attachments.length,
      subject,
    });
    collectGmailParts(detail.payload, collected);

    // extra fallback: top-level payload.body.data
    if (
      collected.html.length === 0 &&
      collected.text.length === 0 &&
      detail?.payload?.body?.data
    ) {
      const decodedTop = decodeBase64UrlToUtf8(detail.payload.body.data);
      if (decodedTop) {
        collected.text.push(decodedTop);
      }
    }

    const providerLogoKey = detectProviderLogoKey({
      subject,
      fromEmail,
      bodyHtml: collected.html[0] || '',
      bodyText: collected.text[0] || detail.snippet || '',
    });
    return {
      id: makeId('gmail'),
      source: 'gmail' as const,
      kind: subjectToKind(subject),
      title: subject,
      subject,
      fromEmail,
      gmailMessageId: messageRef.id,
      gmailThreadId: messageRef.threadId,
      gmailBodyHtml: collected.html[0] || '',
      gmailBodyText: collected.text[0] || detail.snippet || '',
      gmailSnippet: detail.snippet || '',
      gmailAttachments: collected.attachments,
      providerLogoKey,
      paid: false,
      createdAt: new Date().toISOString(),
    } satisfies Item;
  };

  const downloadGmailAttachment = async (
    accessToken: string,
    item: Item,
    att: GmailAttachmentMeta
  ) => {
    if (!item.gmailMessageId) {
      throw new Error('Missing gmailMessageId');
    }

    const url =
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.gmailMessageId}/attachments/${att.attachmentId}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`attachments.get error ${res.status}: ${text}`);
    }

    const json = await res.json();
    const data = json.data as string | undefined;

    if (!data) {
      throw new Error('Attachment data missing');
    }

    const folderUri = `${FileSystem.documentDirectory}gmail_attachments/`;
    await ensureFolder(folderUri);

    const ext = att.filename?.includes('.')
      ? ''
      : `.${extensionFromMimeType(att.mimeType)}`;

    const safeFileName = (att.filename || `attachment_${Date.now()}${ext}`)
      .replace(/[^\w.\-() ]/g, '_');

    const localUri = `${folderUri}${Date.now()}_${safeFileName}`;

    await FileSystem.writeAsStringAsync(localUri, normalizeBase64(data), {
      encoding: FileSystem.EncodingType.Base64,
    });

    setItems((prev) =>
      prev.map((x) =>
        x.id === item.id
          ? {
              ...x,
              gmailDownloadedAttachmentUri: localUri,
              gmailDownloadedAttachmentFileName: att.filename,
              gmailDownloadedAttachmentMimeType: att.mimeType,
            }
          : x
      )
    );
    Alert.alert(
      'Csatolmány letöltve',
      `${att.filename}\n${att.mimeType || 'ismeretlen mime'}`
    );
    return localUri;
  };

  const openGmailItem = async (item: Item) => {
  try {
    const bodyText =
      item.gmailBodyText?.trim() ||
      item.gmailSnippet?.trim() ||
      'Nincs megjeleníthető tartalom.';

    const html = buildHtmlDocument(
      item.title,
      item.gmailBodyHtml?.trim() || '',
      bodyText
    );

    setEmailPreviewTitle(item.title);
    setEmailPreviewHtml(html);
    setEmailPreviewVisible(true);
  } catch (error) {
    console.error(error);
    Alert.alert('Hiba', 'Az email megnyitása nem sikerült.');
  }
};
const openGmailAttachment = async (item: Item) => {
  try {
    if (item.gmailDownloadedAttachmentUri) {
      await openFileUri(
        item.gmailDownloadedAttachmentUri,
        item.gmailDownloadedAttachmentMimeType
      );
      return;
    }

    const previewableAttachment = item.gmailAttachments?.find(isPreviewableAttachment);

    if (!previewableAttachment) {
      Alert.alert('Nincs csatolmány', 'Ehhez az emailhez nincs megnyitható csatolmány.');
      return;
    }

    if (!googleAccessToken) {
      Alert.alert('Hiányzó token', 'A csatolmány letöltéséhez jelentkezz be Google-lal.');
      return;
    }

    const localUri = await downloadGmailAttachment(
      googleAccessToken,
      item,
      previewableAttachment
    );

    await openFileUri(localUri, previewableAttachment.mimeType);
  } catch (error) {
    console.error(error);
    Alert.alert('Hiba', 'A csatolmány megnyitása nem sikerült.');
  }
};

  const handleGetMails = async () => {
    if (!googleAccessToken) {
      Alert.alert('Hiányzó token', 'Előbb jelentkezz be Google-lal.');
      return;
    }

    const senders = [sender1.trim(), sender2.trim(), sender3.trim()].filter(Boolean);

    if (senders.length === 0) {
      Alert.alert('Hiányzó feladó', 'Adj meg legalább 1 feladó email címet.');
      return;
    }

    try {
      setBusy(true);

      await persistSenders(sender1, sender2, sender3);
      const q = senders.map((s) => `from:${s}`).join(' OR ');
      const listUrl =
        `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
        `?maxResults=60&q=${encodeURIComponent(q)}`;

      const listRes = await fetch(listUrl, {
        headers: {
          Authorization: `Bearer ${googleAccessToken}`,
        },
      });

      if (listRes.status === 401) {
        try {
          const fresh = await GoogleSignin.getTokens();
          setGoogleAccessToken(fresh.accessToken);
          await AsyncStorage.setItem(STORAGE_KEYS.GOOGLE_TOKEN, fresh.accessToken);
          return handleGetMailsWithToken(fresh.accessToken, senders);
        } catch {
          Alert.alert(
            'Lejárt token',
            'A token lejárt. Jelentkezz be újra Google-lal.'
          );
          return;
        }
      }

      if (!listRes.ok) {
        const text = await listRes.text();
        throw new Error(`messages.list error ${listRes.status}: ${text}`);
      }

      const listJson = await listRes.json();
      const messages: Array<{ id: string; threadId?: string }> = listJson.messages || [];

      if (messages.length === 0) {
        Alert.alert('Nincs találat', 'Nem találtam ilyen feladóktól emailt.');
        return;
      }

      const gmailItems = await Promise.all(
        messages.slice(0, 10).map(async (msg) => {
          const detail = await fetchMessageFull(googleAccessToken, msg.id);
          return mapFullMessageToItem(detail, msg);
        })
      );

      const filteredGmailItems = gmailItems.filter((x) => looksInvoiceLike(x.subject || ''));

      if (filteredGmailItems.length === 0) {
        Alert.alert(
          'Nincs számla-szerű email',
          'Találtam emaileket, de a subject alapján egyik sem tűnt számlának / bizonylatnak.'
        );
        return;
      }

      setItems((prev) => {
        const existingKeys = new Set(
          prev
            .filter((x) => x.source === 'gmail' && x.gmailMessageId)
            .map((x) => x.gmailMessageId as string)
        );

        const deduped = filteredGmailItems.filter(
          (x) => !existingKeys.has(x.gmailMessageId || '')
        );

        return [...deduped, ...prev];
      });

      Alert.alert(
        'Kész',
        `${filteredGmailItems.length} Gmail alapú tétel feldolgozva.`
      );
    } catch (error) {
      console.error(error);
      Alert.alert('Hiba', 'Nem sikerült a levelek lekérése.');
    } finally {
      setBusy(false);
    }
  };
const handleSharedAsInvoice = () => {
  if (!sharedFile) return;

  const newItem: Item = {
    id: makeId('invoice'),
    source: 'local',
    kind: 'invoice',
    title: sharedFile.fileName || 'Számla',
    paid: false,
    createdAt: new Date().toISOString(),
    fileName: sharedFile.fileName,
    mimeType: sharedFile.mimeType,
    localUri: sharedFile.localUri,
    originalUri: sharedFile.originalUri,
  };

  setItems((prev) => [newItem, ...prev]);

  setShareModalVisible(false);
  setSharedFile(null);
  resetShareIntent();
};

const handleSharedAsReceipt = () => {
  if (!sharedFile) return;

  setPendingReceiptFile(sharedFile);
  setShareModalVisible(false);
  setReceiptAttachModalVisible(true);
  resetShareIntent();
};
  const handleGetMailsWithToken = async (token: string, senders: string[]) => {
    try {
      const q = senders.map((s) => `from:${s}`).join(' OR ');
      const listUrl =
        `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
        `?maxResults=60&q=${encodeURIComponent(q)}`;

      const listRes = await fetch(listUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!listRes.ok) {
        const text = await listRes.text();
        throw new Error(`messages.list error ${listRes.status}: ${text}`);
      }

      const listJson = await listRes.json();
      const messages: Array<{ id: string; threadId?: string }> = listJson.messages || [];

      if (messages.length === 0) {
        Alert.alert('Nincs találat', 'Nem találtam ilyen feladóktól emailt.');
        return;
      }

      const gmailItems = await Promise.all(
        messages.slice(0, 10).map(async (msg) => {
          const detail = await fetchMessageFull(token, msg.id);
          return mapFullMessageToItem(detail, msg);
        })
      );

      const filteredGmailItems = gmailItems.filter((x) => looksInvoiceLike(x.subject || ''));

      setItems((prev) => {
        const existingKeys = new Set(
          prev
            .filter((x) => x.source === 'gmail' && x.gmailMessageId)
            .map((x) => x.gmailMessageId as string)
        );

        const deduped = filteredGmailItems.filter(
          (x) => !existingKeys.has(x.gmailMessageId || '')
        );

        return [...deduped, ...prev];
      });

      Alert.alert(
        'Kész',
        `${filteredGmailItems.length} Gmail alapú tétel feldolgozva.`
      );
    } catch (error) {
      console.error(error);
      Alert.alert('Hiba', 'Nem sikerült a levelek lekérése friss tokennel sem.');
    }
  };

  const onRefresh = async () => {
    if (!googleAccessToken || busy) return;

    try {
      setRefreshing(true);
      await handleGetMails();
    } finally {
      setRefreshing(false);
    }
  };

  const renderBadge = (
    label: string,
    variant: 'default' | 'primary' | 'success' = 'default'
  ) => (
    <View
      style={[
        styles.badge,
        variant === 'primary' && styles.badgePrimary,
        variant === 'success' && styles.badgeSuccess,
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          variant === 'primary' && styles.badgeTextPrimary,
          variant === 'success' && styles.badgeTextSuccess,
        ]}
      >
        {label}
      </Text>
    </View>
  );

  const isSummaryActive = (mode: FilterMode) => {
    if (filterMode === 'all') return true;
    return filterMode === mode;
  };

  const getAccentStyle = (item: Item) => {
    if (item.paid) return styles.cardAccentPaid;
    return styles.cardAccentUnpaid;
  };
    const renderProviderLogoBadge = (
      item: Item,
      options?: { clickable?: boolean; compact?: boolean }
    ) => {
      if (!item.providerLogoKey) return null;

      const source =
        item.providerLogoKey === 'eon'
          ? require('../../assets/images/eon.png')
          : item.providerLogoKey === 'electrica'
          ? require('../../assets/images/electrica.png')
          : item.providerLogoKey === 'hidroelectrica'
          ? require('../../assets/images/hidroelectrica.png')
          : require('../../assets/images/digi.png');

      const content = (
        <View style={[styles.logoBadge, options?.compact && styles.logoBadgeCompact]}>
          <Image
            source={source}
            style={[styles.logoBadgeImage, options?.compact && styles.logoBadgeImageCompact]}
            resizeMode="contain"
          />
        </View>
      );

      if (!options?.clickable) {
        return content;
      }

      return (
        <Pressable onPress={() => setProviderFilter(item.providerLogoKey || null)}>
          {content}
        </Pressable>
      );
    };
    const renderReceiptBadge = (item: Item) => {
  const has = hasReceipt(item);

  return (
    <Pressable
      style={[
        styles.badge,
        has ? styles.badgeSuccess : null,
      ]}
      onPress={() => {
        if (has) {
          openReceiptFile(item);
        } else {
          addReceiptToSpecificInvoice(item.id);
        }
      }}
    >
      <Text
        style={[
          styles.badgeText,
          has ? styles.badgeTextSuccess : null,
        ]}
      >
        bizonylat
      </Text>
    </Pressable>
  );
};
  return (
    <SafeAreaView style={styles.safe}>
      <View
        style={[
          styles.container,
          { paddingTop: Math.max(insets.top + 8, 20) },
        ]}
      >
        <Pressable
          style={styles.profileFab}
          onPress={() => setSettingsModalVisible(true)}
        >
          <Text style={styles.profileFabText}>F</Text>
        </Pressable>

        <View style={styles.headerBlock}>
          <Text style={styles.title}>Szabadság u. 34, Tg-Mures</Text>
          <Text style={styles.subtitle}>Szondi Géza</Text>
        </View>

        <View style={styles.summaryRow}>
          <Pressable
            style={[
              styles.summaryChip,
              isSummaryActive('all') && styles.summaryChipActive,
            ]}
            onPress={() => setFilterMode('all')}
          >
            <Text
              style={[
                styles.summaryChipLabel,
                isSummaryActive('all') && styles.summaryChipLabelActive,
              ]}
            >
              Összes
            </Text>
            <Text
              style={[
                styles.summaryChipValue,
                isSummaryActive('all') && styles.summaryChipValueActive,
              ]}
            >
              {items.length}
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.summaryChip,
              isSummaryActive('paid') && styles.summaryChipActive,
            ]}
            onPress={() => setFilterMode('paid')}
          >
            <Text
              style={[
                styles.summaryChipLabel,
                isSummaryActive('paid') && styles.summaryChipLabelActive,
              ]}
            >
              Paid
            </Text>
            <Text
              style={[
                styles.summaryChipValue,
                isSummaryActive('paid') && styles.summaryChipValueActive,
              ]}
            >
              {paidCount}
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.summaryChip,
              isSummaryActive('unpaid') && styles.summaryChipActive,
            ]}
            onPress={() => setFilterMode('unpaid')}
          >
            <Text
              style={[
                styles.summaryChipLabel,
                isSummaryActive('unpaid') && styles.summaryChipLabelActive,
              ]}
            >
              Unpaid
            </Text>
            <Text
              style={[
                styles.summaryChipValue,
                isSummaryActive('unpaid') && styles.summaryChipValueActive,
              ]}
            >
              {unpaidCount}
            </Text>
          </Pressable>
        </View>

          {providerFilter ? (
        <View style={styles.providerFilterRow}>
          <View style={styles.providerFilterBadgeWrap}>
            {renderProviderLogoBadge({ providerLogoKey: providerFilter } as Item, { compact: true })}
            <Pressable
              style={styles.providerFilterClose}
              onPress={() => setProviderFilter(null)}
            >
              <Text style={styles.providerFilterCloseText}>×</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#8f6e28"
              colors={['#8f6e28']}
              enabled={!!googleAccessToken}
            />
          }
        >
          {loading ? (
            <Text style={styles.emptyText}>Betöltés...</Text>
          ) : filteredItems.length === 0 ? (
            <Text style={styles.emptyText}>
              {items.length === 0
                ? 'Még nincs egyetlen tétel sem.'
                : 'Nincs találat az aktuális szűrőhöz.'}
            </Text>
          ) : (
            filteredItems.map((item) => (
              <Pressable
                  key={item.id}
                  style={styles.card}
                  onPress={() => {
                    if (item.source === 'local') {
                      openLocalFile(item);
                    } else {
                      openGmailItem(item);
                    }
                  }}
                >
                <View style={[styles.cardAccent, getAccentStyle(item)]} />

                <View style={styles.cardTop}>
                  <View style={{ flex: 1, paddingLeft: 4 }}>
                    <Text style={styles.cardTitle}>{item.title}</Text>
                    <Text style={styles.cardMeta}>
                      {new Date(item.createdAt).toLocaleString()}
                    </Text>
                  </View>

                  <Switch value={item.paid} onValueChange={() => togglePaid(item.id)} />
                </View>

                <View style={styles.badgesRow}>
                  {item.source === 'gmail' ? renderProviderLogoBadge(item, { clickable: true }) : null}

                  {renderReceiptBadge(item)}

                  {item.source === 'gmail' && item.gmailAttachments?.some(isPreviewableAttachment) ? (
                    <Pressable
                      style={[styles.badge, styles.badgePrimary]}
                      onPress={() => openGmailAttachment(item)}
                    >
                      <Text style={[styles.badgeText, styles.badgeTextPrimary]}>
                        csatolmány
                      </Text>
                    </Pressable>
                  ) : null}

                  {/* {renderBadge(item.paid ? 'paid' : 'unpaid', item.paid ? 'success' : 'default')} */}
                </View>

                {item.source === 'local' ? (
                  <>
                    {/* {!!item.receiptLocalUri ? (
                      <Pressable
                        style={styles.secondaryOpenButton}
                        onPress={() => openReceiptFile(item)}
                      >
                        <Text style={styles.secondaryOpenButtonText}>
                          Bizonylat megnyitása
                        </Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        style={styles.secondaryAddButton}
                        onPress={() => addReceiptToSpecificInvoice(item.id)}
                      >
                        <Text style={styles.secondaryAddButtonText}>
                          Bizonylat hozzáadása
                        </Text>
                      </Pressable>
                    )} */}
                  </>
                ) : (
                  <>
                    <Text style={styles.cardMeta}>
                      Feladó: {item.fromEmail || 'ismeretlen'}
                    </Text>

                    {/* {!!item.receiptLocalUri ? (
                      <Pressable
                        style={styles.secondaryOpenButton}
                        onPress={() => openReceiptFile(item)}
                      >
                        <Text style={styles.secondaryOpenButtonText}>
                          Bizonylat megnyitása
                        </Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        style={styles.secondaryAddButton}
                        onPress={() => addReceiptToSpecificInvoice(item.id)}
                      >
                        <Text style={styles.secondaryAddButtonText}>
                          Bizonylat hozzáadása
                        </Text>
                      </Pressable>
                    )} */}
                  </>
                )}
              </Pressable>
            ))
          )}
        </ScrollView>
        <View
          style={[
            styles.bottomFabRow,
            { bottom: Math.max(insets.bottom + 12, 20) },
          ]}
        >
          <Pressable
            style={styles.bottomLeftFab}
            onPress={addInvoice}
            disabled={busy}
          >
            <Text style={styles.bottomFabText}>+Számla</Text>
          </Pressable>

          <Pressable
            style={styles.bottomRightFab}
            onPress={addReceipt}
            disabled={busy}
          >
            <Text style={styles.bottomFabText}>+Bizonylat</Text>
          </Pressable>
        </View>
        <Modal
          visible={settingsModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setSettingsModalVisible(false)}
        >
          <View style={styles.modalBackdropCenter}>
            <View style={styles.settingsCard}>
              <View style={styles.settingsHeader}>
                <Text style={styles.modalTitle}>Google / Gmail</Text>

                <Pressable
                  style={styles.closeCircle}
                  onPress={() => setSettingsModalVisible(false)}
                >
                  <Text style={styles.closeCircleText}>×</Text>
                </Pressable>
              </View>

              <Text style={styles.smallText}>
                {googleUserEmail
                  ? `Bejelentkezve: ${googleUserEmail}`
                  : 'Nincs Google login'}
              </Text>

              <View style={styles.row}>
                <Pressable
                  style={[
                    styles.primaryButton,
                    (busy || !!googleAccessToken) && styles.disabledButton,
                  ]}
                  onPress={handleGoogleLogin}
                  disabled={busy || !!googleAccessToken}
                >
                  <Text style={styles.primaryButtonText}>Google Login</Text>
                </Pressable>

                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => setSenderModalVisible(true)}
                  disabled={busy}
                >
                  <Text style={styles.secondaryButtonText}>Feladók</Text>
                </Pressable>
              </View>

              <View style={styles.row}>
                <Pressable
                  style={[
                    styles.primaryButton,
                    (busy || !googleAccessToken) && styles.disabledButton,
                  ]}
                  onPress={handleGetMails}
                  disabled={busy || !googleAccessToken}
                >
                  <Text style={styles.primaryButtonText}>Get Mails</Text>
                </Pressable>

                <Pressable
                  style={[
                    styles.secondaryButton,
                    (busy || !googleAccessToken) && styles.disabledButtonSecondary,
                  ]}
                  onPress={handleGoogleLogout}
                  disabled={busy || !googleAccessToken}
                >
                  <Text style={styles.secondaryButtonText}>Logout</Text>
                </Pressable>
              </View>

              <View style={styles.row}>
                <Pressable
                  style={styles.secondaryButton}
                  onPress={handleClearGmailItems}
                  disabled={busy}
                >
                  <Text style={styles.secondaryButtonText}>Lista törlése</Text>
                </Pressable>
              </View>

              <Text style={styles.smallMuted}>
                Aktív feladók: {[sender1, sender2, sender3].filter(Boolean).join(', ') || 'nincs megadva'}
              </Text>
              <Text style={styles.smallMuted}>
                Tipp: pull-to-refresh a főoldalon mail frissítéshez.
              </Text>
            </View>
          </View>
        </Modal>

        <Modal
          visible={senderModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setSenderModalVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Gmail feladók</Text>

              <TextInput
                style={styles.input}
                value={sender1}
                onChangeText={setSender1}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="felado1@pelda.hu"
                placeholderTextColor="#8e8269"
              />

              <TextInput
                style={styles.input}
                value={sender2}
                onChangeText={setSender2}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="felado2@pelda.hu"
                placeholderTextColor="#8e8269"
              />
              <TextInput
                style={styles.input}
                value={sender3}
                onChangeText={setSender3}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="felado3@pelda.hu"
                placeholderTextColor="#8e8269"
              />
              <View style={styles.row}>
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => setSenderModalVisible(false)}
                >
                  <Text style={styles.secondaryButtonText}>Mégse</Text>
                </Pressable>

                <Pressable
                  style={styles.primaryButton}
                  onPress={async () => {
                    await persistSenders(sender1, sender2, sender3);
                    setSenderModalVisible(false);
                  }}
                >
                  <Text style={styles.primaryButtonText}>Mentés</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          visible={receiptAttachModalVisible}
          transparent
          animationType="slide"
          onRequestClose={cancelAttachReceipt}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Bizonylat csatolása</Text>
              <Text style={styles.smallText}>
                Válaszd ki, melyik unpaid számlához tartozik a kiválasztott bizonylat.
              </Text>

              <ScrollView style={{ maxHeight: 360 }}>
                {unpaidInvoices.map((invoice) => (
                  <Pressable
                    key={invoice.id}
                    style={styles.invoicePickRow}
                    onPress={() => attachReceiptToInvoice(invoice.id)}
                  >
                    <View style={styles.invoicePickContent}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.invoicePickTitle}>{invoice.title}</Text>
                        <Text style={styles.invoicePickMeta}>
                          {new Date(invoice.createdAt).toLocaleString()}
                        </Text>
                      </View>

                      {renderProviderLogoBadge(invoice)}
                    </View>
                  </Pressable>
                ))}
              </ScrollView>

              <View style={styles.row}>
                <Pressable
                  style={styles.secondaryButton}
                  onPress={cancelAttachReceipt}
                >
                  <Text style={styles.secondaryButtonText}>Mégse</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          visible={emailPreviewVisible}
          animationType="slide"
          onRequestClose={() => setEmailPreviewVisible(false)}
        >
          <SafeAreaView style={styles.previewSafe}>
              <View
                style={[
                  styles.previewHeader,
                  { paddingTop: Math.max(insets.top, 12) }
                ]}
              >
              <Text numberOfLines={1} style={styles.previewTitle}>
                {emailPreviewTitle}
              </Text>
              <Pressable
                style={styles.closeCircle}
                onPress={() => setEmailPreviewVisible(false)}
              >
                <Text style={styles.closeCircleText}>×</Text>
              </Pressable>
            </View>

            <WebView
              originWhitelist={['*']}
              source={{ html: emailPreviewHtml }}
              style={styles.webview}
            />
          </SafeAreaView>
        </Modal>
        <Modal
          visible={shareModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setShareModalVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Fájl hozzáadása</Text>

              <Text style={styles.smallText}>
                {sharedFile?.fileName || 'Ismeretlen fájl'}
              </Text>

              <View style={styles.row}>
                <Pressable
                  style={styles.primaryButton}
                  onPress={handleSharedAsInvoice}
                >
                  <Text style={styles.primaryButtonText}>+Számla</Text>
                </Pressable>

                <Pressable
                  style={styles.secondaryButton}
                  onPress={handleSharedAsReceipt}
                >
                  <Text style={styles.secondaryButtonText}>+Bizonylat</Text>
                </Pressable>
              </View>

              <View style={styles.row}>
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => {
                    setShareModalVisible(false);
                    setSharedFile(null);
                    resetShareIntent();
                  }}
                >
                  <Text style={styles.secondaryButtonText}>Mégse</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f4efe3',
  },
  container: {
    flex: 1,
    paddingHorizontal: 16,
  },
  headerBlock: {
    paddingTop: 8,
    paddingRight: 72,
    marginBottom: 14,
  },
  title: {
    color: '#335c1b',
    fontSize: 23,
    fontWeight: '800',
    lineHeight: 30,
  },
  subtitle: {
    color: '#8f6e28',
    marginTop: 6,
    fontSize: 16,
    fontWeight: '700',
  },
  profileFab: {
    position: 'absolute',
    top: 38,
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#2f7d14',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  profileFabText: {
    color: '#fffdf7',
    fontWeight: '800',
    fontSize: 16,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  summaryChip: {
    flex: 1,
    minHeight: 50,
    borderRadius: 14,
    backgroundColor: '#e7dcc3',
    borderWidth: 1,
    borderColor: '#d5c6a2',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summaryChipActive: {
    backgroundColor: '#d7c07d',
    borderColor: '#bea35c',
  },
  summaryChipLabel: {
    color: '#71531f',
    fontSize: 13,
    fontWeight: '700',
  },
  summaryChipLabelActive: {
    color: '#714c15',
  },
  summaryChipValue: {
    color: '#9d4d34',
    fontSize: 18,
    fontWeight: '800',
    marginLeft: 8,
  },
  summaryChipValueActive: {
    color: '#8f3f2f',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#d7c07d',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#bea35c',
  },
  providerFilterRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: -4,
    marginBottom: 14,
  },
  providerFilterBadgeWrap: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  providerFilterClose: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d5c6a2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerFilterCloseText: {
    fontSize: 12,
    lineHeight: 12,
    color: '#7b6441',
    fontWeight: '800',
  },
  logoBadgeCompact: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  logoBadgeImageCompact: {
    width: 44,
    height: 18,
  },
  primaryButtonText: {
    color: '#8f3f2f',
    fontWeight: '800',
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: '#cfbc84',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#b49955',
  },
  secondaryButtonText: {
    color: '#8f3f2f',
    fontWeight: '800',
  },
  disabledButton: {
    opacity: 0.45,
  },
  disabledButtonSecondary: {
    opacity: 0.45,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 120,
  },
  emptyText: {
    color: '#8e8269',
    textAlign: 'center',
    marginTop: 32,
    fontSize: 14,
  },
  card: {
    position: 'relative',
    backgroundColor: '#efe4c3',
    overflow: 'hidden',
    borderRadius: 16,
    padding: 14,
    paddingLeft: 18,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#dcc99b',
  },
  cardAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 6,
  },
  cardAccentPaid: {
    backgroundColor: '#2f7d14',
  },
  cardAccentUnpaid: {
    backgroundColor: '#c84f3a',
  },
  cardTop: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  cardTitle: {
    color: '#6e4322',
    fontSize: 16,
    fontWeight: '800',
  },
  cardMeta: {
    color: '#8a7754',
    marginTop: 6,
    fontSize: 12,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
    marginBottom: 10,
    paddingLeft: 4,
  },
  logoBadge: {
    backgroundColor: '#ffffff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e5e5',
  },
  logoBadgeImage: {
    width: 44,
    height: 18,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#e5d7b1',
    borderRadius: 999,
  },
  badgePrimary: {
    backgroundColor: '#d7c07d',
  },
  badgeSuccess: {
    backgroundColor: '#2f7d14',
  },
  badgeText: {
    color: '#7b6441',
    fontSize: 12,
    fontWeight: '700',
  },
  badgeTextPrimary: {
    color: '#8f3f2f',
  },
  badgeTextSuccess: {
    color: '#fffdf7',
  },
  openButton: {
    marginTop: 10,
    backgroundColor: '#2f7d14',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  openButtonText: {
    color: '#fffdf7',
    fontWeight: '800',
  },
  secondaryOpenButton: {
    marginTop: 8,
    backgroundColor: '#8f6e28',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryOpenButtonText: {
    color: '#fffdf7',
    fontWeight: '800',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(35,24,8,0.35)',
    justifyContent: 'flex-end',
  },
  modalBackdropCenter: {
    flex: 1,
    backgroundColor: 'rgba(35,24,8,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryAddButton: {
    marginTop: 8,
    backgroundColor: '#d9cda8',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#c9b98b',
  },
  secondaryAddButtonText: {
    color: '#7c6540',
    fontWeight: '800',
  },
  bottomFabRow: {
    position: 'absolute',
    left: 4,
    right: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 60,
    elevation: 10,
  },
  bottomLeftFab: {
    backgroundColor: '#d7c07d',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#bea35c',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  bottomRightFab: {
    backgroundColor: '#cfbc84',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#b49955',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  bottomFabText: {
    color: '#8f3f2f',
    fontWeight: '800',
    fontSize: 14,
  },
  modalCard: {
    backgroundColor: '#f4efe3',
    padding: 16,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#dcc99b',
  },
  settingsCard: {
    backgroundColor: '#f4efe3',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#dcc99b',
  },
  settingsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  closeCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#e7dcc3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeCircleText: {
    color: '#6e4322',
    fontSize: 22,
    lineHeight: 22,
    fontWeight: '500',
  },
  modalTitle: {
    color: '#335c1b',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 12,
  },
  input: {
    backgroundColor: '#efe4c3',
    color: '#6e4322',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#dcc99b',
  },
  smallText: {
    color: '#6e4322',
    marginBottom: 8,
  },
  smallMuted: {
    color: '#8a7754',
    fontSize: 12,
    marginTop: 2,
  },
  invoicePickRow: {
    backgroundColor: '#efe4c3',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#dcc99b',
  },
  invoicePickContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  invoicePickTitle: {
    color: '#6e4322',
    fontWeight: '800',
    fontSize: 15,
  },
  invoicePickMeta: {
    color: '#8a7754',
    fontSize: 12,
    marginTop: 4,
  },
  previewSafe: {
    flex: 1,
    backgroundColor: '#f4efe3',
  },
  previewHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#dcc99b',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  previewTitle: {
    flex: 1,
    marginRight: 12,
    color: '#335c1b',
    fontWeight: '800',
    fontSize: 16,
  },
  webview: {
    flex: 1,
    backgroundColor: '#f4efe3',
  },
});