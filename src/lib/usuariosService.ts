import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc
} from 'firebase/firestore';
import { db } from './firebase';
import { UsuarioItem, ModoEnvioTelegram, UsuarioTelegramConfigItem } from '../types';

const USER_SYNC_KEY = (uid: string) => `cadservicos_user_sync_${uid}`;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Registra ou atualiza o perfil do usuário na coleção 'usuarios'
 * OTIMIZADO: Só grava no Firestore no primeiro acesso ou a cada 24 horas (ou se o nome/email mudou),
 * evitando dezenas de escritas a cada abertura de aba ou recarregamento.
 */
export const registrarOuAtualizarUsuario = async (user: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
}): Promise<void> => {
  if (!user.uid) return;

  const nome = user.displayName || user.email?.split('@')[0] || 'Técnico';
  const email = user.email || '';
  const cacheKey = USER_SYNC_KEY(user.uid);

  try {
    const rawCache = localStorage.getItem(cacheKey);
    if (rawCache) {
      const cached = JSON.parse(rawCache);
      const agora = Date.now();
      // Se sincronizou há menos de 24h e os dados não mudaram, não faz gravação no Firestore
      if (
        agora - (cached.timestamp || 0) < SYNC_INTERVAL_MS &&
        cached.email === email &&
        cached.nome === nome
      ) {
        return;
      }
    }

    const userDocRef = doc(db, 'usuarios', user.uid);
    const dadosAtualizados: Partial<UsuarioItem> = {
      uid: user.uid,
      email,
      nome,
      ultimoAcesso: Date.now()
    };

    // Gravação direta sem leitura prévia desnecessária (1 escrita no máximo a cada 24 horas)
    await setDoc(userDocRef, dadosAtualizados, { merge: true });

    // Salva no cache local para bloquear novas gravações nas próximas 24 horas
    localStorage.setItem(
      cacheKey,
      JSON.stringify({
        timestamp: Date.now(),
        email,
        nome
      })
    );
  } catch (err) {
    console.warn('Erro ao atualizar perfil do usuário no Firestore:', err);
  }
};

/**
 * Lista todos os usuários cadastrados na coleção 'usuarios' com suas configurações do Telegram
 */
export const listarTodosUsuarios = async (): Promise<UsuarioItem[]> => {
  try {
    const usuariosCol = collection(db, 'usuarios');
    const snapshot = await getDocs(usuariosCol);
    
    const lista: UsuarioItem[] = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const privChat = data.telegramPrivadoChatId || data.telegramChatId || '';
      lista.push({
        uid: docSnap.id,
        email: data.email || '',
        nome: data.nome || data.displayName || data.email?.split('@')[0] || 'Técnico',
        telegramChatId: privChat,
        telegramPrivadoChatId: privChat,
        telegramGrupoChatId: data.telegramGrupoChatId || '',
        telegramModoEnvio: (data.telegramModoEnvio as ModoEnvioTelegram) || 'padrao',
        telegramBotToken: data.telegramBotToken || '',
        ultimoAcesso: data.ultimoAcesso || data.createdAt || 0,
        createdAt: data.createdAt || 0
      });
    });

    // Ordenar por nome alfabético
    lista.sort((a, b) => a.nome.localeCompare(b.nome));
    return lista;
  } catch (err) {
    console.warn('Erro ao listar usuários do Firestore:', err);
    return [];
  }
};

/**
 * Salva a configuração individual do Telegram de um usuário/técnico específico.
 * Somente executado pelo Administrador.
 */
export const salvarTelegramUsuario = async (
  uid: string,
  config: {
    privadoChatId?: string;
    grupoChatId?: string;
    modoEnvio?: ModoEnvioTelegram;
  }
): Promise<void> => {
  if (!uid) return;

  const cleanPrivado = (config.privadoChatId || '').trim();
  const cleanGrupo = (config.grupoChatId || '').trim();
  const modoEnvio = config.modoEnvio || 'padrao';

  // 1. Atualiza no documento do usuário
  const userDocRef = doc(db, 'usuarios', uid);
  await setDoc(
    userDocRef,
    {
      telegramChatId: cleanPrivado, // legado
      telegramPrivadoChatId: cleanPrivado,
      telegramGrupoChatId: cleanGrupo,
      telegramModoEnvio: modoEnvio,
      updatedAt: Date.now()
    },
    { merge: true }
  );

  // 2. Atualiza no documento consolidado config/telegram
  try {
    const configDocRef = doc(db, 'config', 'telegram');
    const configSnap = await getDoc(configDocRef);
    const data = configSnap.exists() ? configSnap.data() : {};
    const userConfigs = (data.userConfigs || {}) as Record<string, UsuarioTelegramConfigItem>;
    const userChatIds = (data.userChatIds || {}) as Record<string, string>;

    userConfigs[uid] = {
      privadoChatId: cleanPrivado,
      grupoChatId: cleanGrupo,
      modoEnvio: modoEnvio
    };

    if (cleanPrivado) {
      userChatIds[uid] = cleanPrivado;
    } else {
      delete userChatIds[uid];
    }

    await setDoc(
      configDocRef,
      {
        userConfigs,
        userChatIds,
        updatedAt: Date.now()
      },
      { merge: true }
    );
  } catch (err) {
    console.warn('Erro ao sincronizar userConfigs no config/telegram:', err);
  }
};

/**
 * Aplica as configurações do Telegram do Administrador para todos os usuários cadastrados.
 * OTIMIZADO: Salva tudo no documento consolidado 'config/telegram' em 1 única escrita no banco.
 */
export const aplicarTelegramAdminParaTodos = async (
  adminBotToken: string,
  adminGrupoChatId: string,
  modoEnvioPadrao: 'ambos' | 'grupo' | 'privado' = 'ambos',
  opcoes?: {
    definirModoEnvioParaTodos?: boolean;
    definirGrupoParaTodos?: boolean;
  }
): Promise<{ total: number }> => {
  const cleanToken = adminBotToken.trim();
  const cleanGrupoChatId = adminGrupoChatId.trim();

  if (!cleanToken || !cleanGrupoChatId) {
    throw new Error('Preencha o Token do Bot e o ID do Grupo do Administrador antes de aplicar.');
  }

  const snapshot = await getDocs(collection(db, 'usuarios'));
  const configDocRef = doc(db, 'config', 'telegram');
  const existingConfigSnap = await getDoc(configDocRef);
  const existingData = existingConfigSnap.exists() ? existingConfigSnap.data() : {};
  
  const userConfigs = (existingData.userConfigs || {}) as Record<string, UsuarioTelegramConfigItem>;
  const userChatIds = (existingData.userChatIds || {}) as Record<string, string>;

  snapshot.forEach((docSnap) => {
    const uid = docSnap.id;
    const current = userConfigs[uid] || {};

    const novoModo: ModoEnvioTelegram = opcoes?.definirModoEnvioParaTodos ? modoEnvioPadrao : (current.modoEnvio || 'padrao');
    const novoGrupo = opcoes?.definirGrupoParaTodos ? cleanGrupoChatId : (current.grupoChatId || cleanGrupoChatId);

    userConfigs[uid] = {
      ...current,
      grupoChatId: novoGrupo,
      modoEnvio: novoModo
    };
  });

  // Salva no config/telegram em 1 ÚNICA escrita consolidada
  await setDoc(
    configDocRef,
    {
      botToken: cleanToken,
      chatId: cleanGrupoChatId,
      grupoChatId: cleanGrupoChatId,
      modoEnvio: modoEnvioPadrao,
      userConfigs,
      userChatIds,
      updatedAt: Date.now()
    },
    { merge: true }
  );

  // Atualiza no LocalStorage local
  localStorage.setItem('cadservicos_telegram_token', cleanToken);
  localStorage.setItem('cadservicos_telegram_chat_id', cleanGrupoChatId);

  return { total: snapshot.size };
};
