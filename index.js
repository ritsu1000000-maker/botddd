import fs from 'node:fs';
import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

const CONFIG_PATH = new URL('./config.json', import.meta.url);

const envConfig = {
  token: process.env.DISCORD_BOT_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  verifiedRoleId: process.env.VERIFIED_ROLE_ID,
};

const requiredEnv = {
  DISCORD_BOT_TOKEN: envConfig.token,
  DISCORD_CLIENT_ID: envConfig.clientId,
  DISCORD_GUILD_ID: envConfig.guildId,
  VERIFIED_ROLE_ID: envConfig.verifiedRoleId,
};

const missingEnv = Object.entries(requiredEnv)
  .filter(([, value]) => !value || String(value).includes('_HERE'))
  .map(([key]) => key);

if (missingEnv.length) {
  console.error(`.env の未設定項目: ${missingEnv.join(', ')}`);
  process.exit(1);
}

let config = {
  channelRules: {},
  permissionSnapshots: {},
  preVerificationRoleId: null,
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...config, ...loaded };

    // v3 からの簡易移行。以前「認証前に見える」に登録したものは visible、
    // Botが管理対象にしていたものは hidden として引き継ぐ。
    if (!loaded.channelRules) {
      const migratedRules = {};
      for (const id of loaded.managedChannelIds ?? []) migratedRules[id] = 'hidden';
      for (const id of loaded.preVerificationChannelIds ?? []) migratedRules[id] = 'visible';
      config.channelRules = migratedRules;
      config.permissionSnapshots = loaded.permissionSnapshots ?? {};
    }
  } catch (error) {
    console.error('config.json の読み込みに失敗しました。JSON形式を確認してください。', error);
    process.exit(1);
  }
}

if (!config.channelRules || typeof config.channelRules !== 'object' || Array.isArray(config.channelRules)) {
  config.channelRules = {};
}
if (!config.permissionSnapshots || typeof config.permissionSnapshots !== 'object' || Array.isArray(config.permissionSnapshots)) {
  config.permissionSnapshots = {};
}
if (config.preVerificationRoleId !== null && typeof config.preVerificationRoleId !== 'string') {
  config.preVerificationRoleId = null;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function canManageVisibility(channel) {
  return channel
    && channel.type !== ChannelType.PublicThread
    && channel.type !== ChannelType.PrivateThread
    && channel.type !== ChannelType.AnnouncementThread
    && channel.permissionOverwrites;
}

function getRuleForChannel(channel) {
  const direct = config.channelRules[channel.id];
  if (direct === 'visible' || direct === 'hidden') return direct;

  if (channel.parentId) {
    const parentRule = config.channelRules[channel.parentId];
    if (parentRule === 'visible' || parentRule === 'hidden') return parentRule;
  }

  return null;
}

function getOverwriteState(channel, roleId) {
  const overwrite = channel.permissionOverwrites.cache.get(roleId);
  if (!overwrite) return 'inherit';
  if (overwrite.allow.has(PermissionFlagsBits.ViewChannel)) return 'allow';
  if (overwrite.deny.has(PermissionFlagsBits.ViewChannel)) return 'deny';
  return 'inherit';
}

function stateToPermission(state) {
  if (state === 'allow') return true;
  if (state === 'deny') return false;
  return null;
}

function snapshotChannel(channel, guild) {
  if (config.permissionSnapshots[channel.id]) return;

  config.permissionSnapshots[channel.id] = {
    everyone: getOverwriteState(channel, guild.roles.everyone.id),
    verified: getOverwriteState(channel, envConfig.verifiedRoleId),
  };
}

async function applyRuleToChannel(channel, rule, guild, verifiedRole) {
  snapshotChannel(channel, guild);

  if (rule === 'visible') {
    // 認証前も認証後も見える。
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { ViewChannel: true },
      { reason: '認証Bot: 認証前から表示' },
    );
    await channel.permissionOverwrites.edit(
      verifiedRole,
      { ViewChannel: true },
      { reason: '認証Bot: 認証済みユーザーにも表示' },
    );
    return;
  }

  if (rule === 'hidden') {
    // 認証前は隠し、認証済みロールには見せる。
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { ViewChannel: false },
      { reason: '認証Bot: 認証完了まで非表示' },
    );
    await channel.permissionOverwrites.edit(
      verifiedRole,
      { ViewChannel: true },
      { reason: '認証Bot: 認証後に表示' },
    );
  }
}

async function restoreChannel(channel, guild, verifiedRole) {
  const snapshot = config.permissionSnapshots[channel.id];

  if (snapshot) {
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { ViewChannel: stateToPermission(snapshot.everyone) },
      { reason: '認証Bot: 管理解除・元の権限へ復元' },
    );
    await channel.permissionOverwrites.edit(
      verifiedRole,
      { ViewChannel: stateToPermission(snapshot.verified) },
      { reason: '認証Bot: 管理解除・元の権限へ復元' },
    );
    delete config.permissionSnapshots[channel.id];
    return true;
  }

  // v3以前から管理され、元状態の記録がない場合はBotのViewChannel指定だけ継承に戻す。
  await channel.permissionOverwrites.edit(
    guild.roles.everyone,
    { ViewChannel: null },
    { reason: '認証Bot: 管理解除' },
  );
  await channel.permissionOverwrites.edit(
    verifiedRole,
    { ViewChannel: null },
    { reason: '認証Bot: 管理解除' },
  );
  return false;
}

function channelsAffectedBySelection(guild, selectedChannel) {
  if (selectedChannel.type !== ChannelType.GuildCategory) return [selectedChannel];

  return [
    selectedChannel,
    ...guild.channels.cache.values().filter(
      (channel) => channel.parentId === selectedChannel.id && canManageVisibility(channel),
    ),
  ];
}

async function applyVerificationVisibility(guild) {
  const verifiedRole = await guild.roles.fetch(envConfig.verifiedRoleId);
  if (!verifiedRole) throw new Error('認証済みロールが見つかりません。');

  const me = guild.members.me;
  if (!me) throw new Error('Botメンバー情報を取得できません。');
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('Botに「チャンネルの管理」権限がありません。');
  }

  await guild.channels.fetch();

  let visibleCount = 0;
  let hiddenCount = 0;
  let untouchedCount = 0;
  let failedCount = 0;

  const channels = [...guild.channels.cache.values()]
    .filter(canManageVisibility)
    .sort((a, b) => {
      const aCategory = a.type === ChannelType.GuildCategory ? 0 : 1;
      const bCategory = b.type === ChannelType.GuildCategory ? 0 : 1;
      return aCategory - bCategory;
    });

  for (const channel of channels) {
    const rule = getRuleForChannel(channel);
    if (!rule) {
      untouchedCount += 1;
      continue;
    }

    try {
      await applyRuleToChannel(channel, rule, guild, verifiedRole);
      if (rule === 'visible') visibleCount += 1;
      if (rule === 'hidden') hiddenCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error(`チャンネル権限変更失敗: ${channel.name} (${channel.id})`, error);
    }
  }

  saveConfig();
  return { visibleCount, hiddenCount, untouchedCount, failedCount };
}

function normalizeHexColor(input) {
  if (!input) return null;
  const normalized = String(input).trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    throw new Error('色は #FF0000 のような6桁HEXで入力してください。');
  }
  return `#${normalized}`;
}

async function getPreVerificationRole(guild) {
  if (!config.preVerificationRoleId) return null;
  return guild.roles.fetch(config.preVerificationRoleId).catch(() => null);
}

async function ensureRoleManageable(guild, role) {
  // Discord側の最新状態を取り直してから判定する。
  const me = await guild.members.fetchMe({ force: true });
  await guild.roles.fetch();

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Botに「ロールの管理」権限がありません。Botのサーバー権限を確認してください。');
  }
  if (role.managed) {
    throw new Error(`「${role.name}」はBot連携などで管理されているため付与できません。`);
  }
  if (role.id === guild.roles.everyone.id) {
    throw new Error('@everyone は付与対象ロールにできません。');
  }

  const freshRole = guild.roles.cache.get(role.id) ?? role;
  if (!freshRole.editable || freshRole.position >= me.roles.highest.position) {
    throw new Error(
      `「${freshRole.name}」をBotの一番上のロール「${me.roles.highest.name}」より下へ移動してください。`,
    );
  }
  return freshRole;
}

async function fetchFreshMember(guild, userId) {
  return guild.members.fetch({ user: userId, force: true });
}

async function addRoleAndConfirm(member, role, reason) {
  const manageableRole = await ensureRoleManageable(member.guild, role);
  let freshMember = await fetchFreshMember(member.guild, member.id);

  if (!freshMember.roles.cache.has(manageableRole.id)) {
    await freshMember.roles.add(manageableRole, reason);
  }

  // APIから再取得し、実際にDiscord側へ反映されたことまで確認する。
  freshMember = await fetchFreshMember(member.guild, member.id);
  if (!freshMember.roles.cache.has(manageableRole.id)) {
    throw new Error(`「${manageableRole.name}」ロールの付与をDiscord側で確認できませんでした。`);
  }

  return freshMember;
}

async function removeRoleAndConfirm(member, role, reason) {
  const manageableRole = await ensureRoleManageable(member.guild, role);
  let freshMember = await fetchFreshMember(member.guild, member.id);

  if (freshMember.roles.cache.has(manageableRole.id)) {
    await freshMember.roles.remove(manageableRole, reason);
  }

  freshMember = await fetchFreshMember(member.guild, member.id);
  if (freshMember.roles.cache.has(manageableRole.id)) {
    throw new Error(`「${manageableRole.name}」ロールの解除をDiscord側で確認できませんでした。`);
  }

  return freshMember;
}

async function addPreVerificationRole(member) {
  if (!config.preVerificationRoleId || member.user.bot) return false;
  const role = await getPreVerificationRole(member.guild);
  if (!role) return false;

  const freshMember = await fetchFreshMember(member.guild, member.id);
  if (freshMember.roles.cache.has(role.id)) return false;

  await addRoleAndConfirm(freshMember, role, '認証前ロールを自動付与');
  console.log(`認証前ロール反映OK: ${member.user.tag} -> ${role.name}`);
  return true;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const commands = [
  new SlashCommandBuilder()
    .setName('認証パネル')
    .setDescription('認証ボタンをこのチャンネルに設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('チャンネル表示設定')
    .setDescription('認証前に見える/見えないチャンネルを設定します')
    .addChannelOption((option) =>
      option
        .setName('チャンネル')
        .setDescription('設定するチャンネルまたはカテゴリ')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('状態')
        .setDescription('認証前の表示状態')
        .setRequired(true)
        .addChoices(
          { name: '見える（認証前から表示）', value: 'visible' },
          { name: '見えない（認証後に表示）', value: 'hidden' },
          { name: '設定解除（元の権限へ戻す）', value: 'clear' },
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('チャンネル表示一覧')
    .setDescription('認証前のチャンネル表示設定を確認します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('認証権限反映')
    .setDescription('保存したチャンネル表示設定を権限へ反映します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('認証前ロール設定')
    .setDescription('認証前に付けるロールと色を設定します')
    .addRoleOption((option) =>
      option
        .setName('ロール')
        .setDescription('認証前に付与するロール')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('色')
        .setDescription('ロール色。例: #FF0000（省略すると現在色のまま）')
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('認証前ロール確認')
    .setDescription('現在の認証前ロール設定を確認します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('認証前ロール配布')
    .setDescription('未認証の既存メンバーにも認証前ロールを付与します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ロール診断')
    .setDescription('認証ロールがBotから実際に付与できる状態か確認します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(envConfig.token);
  await rest.put(
    Routes.applicationGuildCommands(envConfig.clientId, envConfig.guildId),
    { body: commands },
  );
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`起動しました: ${readyClient.user.tag}`);
  console.log('表示設定: /チャンネル表示設定');
  console.log('設定一覧: /チャンネル表示一覧');
  console.log('権限反映: /認証権限反映');
  console.log('認証前ロール: /認証前ロール設定');
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await addPreVerificationRole(member);
  } catch (error) {
    console.error(`認証前ロールの自動付与に失敗: ${member.user.tag}`, error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: 'サーバー内で実行してください。', ephemeral: true });
        return;
      }

      if (interaction.commandName === '認証パネル') {
        const embed = new EmbedBuilder()
          .setTitle('サーバー認証')
          .setDescription('下の「認証する」ボタンを押すと、認証済みロールが付与されます。')
          .setFooter({ text: 'Discordのパスワードやトークンを入力する必要はありません。' });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('verify_member')
            .setLabel('認証する')
            .setStyle(ButtonStyle.Success),
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: '認証パネルを設置しました。', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'チャンネル表示設定') {
        const selectedChannel = interaction.options.getChannel('チャンネル', true);
        const state = interaction.options.getString('状態', true);

        if (!canManageVisibility(selectedChannel)) {
          await interaction.reply({
            content: 'その種類のチャンネルは設定対象にできません。通常チャンネルかカテゴリを選んでください。',
            ephemeral: true,
          });
          return;
        }

        await interaction.guild.channels.fetch();
        const verifiedRole = await interaction.guild.roles.fetch(envConfig.verifiedRoleId);
        if (!verifiedRole) {
          await interaction.reply({ content: '認証済みロールが見つかりません。', ephemeral: true });
          return;
        }

        const targets = channelsAffectedBySelection(interaction.guild, selectedChannel);

        if (state === 'clear') {
          await interaction.deferReply({ ephemeral: true });
          let restored = 0;
          let inherited = 0;
          let failed = 0;

          // カテゴリのルールを消す。子チャンネルに直接設定がある場合はそれを残す。
          delete config.channelRules[selectedChannel.id];

          for (const channel of targets) {
            // 子に直接ルールがある場合、カテゴリ解除だけではその子を解除しない。
            if (channel.id !== selectedChannel.id && config.channelRules[channel.id]) continue;

            try {
              const hadSnapshot = await restoreChannel(channel, interaction.guild, verifiedRole);
              if (hadSnapshot) restored += 1;
              else inherited += 1;
            } catch (error) {
              failed += 1;
              console.error(`権限復元失敗: ${channel.name}`, error);
            }
          }

          saveConfig();
          await interaction.editReply(
            `${selectedChannel} のBot管理を解除しました。\n` +
            `元の権限へ復元: ${restored}\n` +
            `継承へ戻したもの: ${inherited}\n` +
            `失敗: ${failed}`,
          );
          return;
        }

        config.channelRules[selectedChannel.id] = state;
        saveConfig();

        await interaction.deferReply({ ephemeral: true });
        let changed = 0;
        let failed = 0;
        for (const channel of targets) {
          // 子に直接ルールがある場合は、カテゴリ設定より子設定を優先。
          const effectiveRule = getRuleForChannel(channel);
          try {
            await applyRuleToChannel(channel, effectiveRule, interaction.guild, verifiedRole);
            changed += 1;
          } catch (error) {
            failed += 1;
            console.error(`権限変更失敗: ${channel.name}`, error);
          }
        }
        saveConfig();

        const label = state === 'visible'
          ? '認証前から見える'
          : '認証完了まで見えない';

        await interaction.editReply(
          `${selectedChannel} を「${label}」に設定しました。\n` +
          (selectedChannel.type === ChannelType.GuildCategory ? 'カテゴリ内のチャンネルにも反映しました。\n' : '') +
          `変更: ${changed} / 失敗: ${failed}`,
        );
        return;
      }

      if (interaction.commandName === 'チャンネル表示一覧') {
        await interaction.guild.channels.fetch();

        const visible = [];
        const hidden = [];
        const missing = [];

        for (const [id, rule] of Object.entries(config.channelRules)) {
          const channel = interaction.guild.channels.cache.get(id);
          if (!channel) {
            missing.push(id);
            continue;
          }
          const line = `${channel} — ${channel.name}${channel.type === ChannelType.GuildCategory ? '（カテゴリ）' : ''}`;
          if (rule === 'visible') visible.push(line);
          if (rule === 'hidden') hidden.push(line);
        }

        const sections = [
          `**認証前から見える**\n${visible.length ? visible.map((x) => `• ${x}`).join('\n') : 'なし'}`,
          `**認証完了まで見えない**\n${hidden.length ? hidden.map((x) => `• ${x}`).join('\n') : 'なし'}`,
        ];
        if (missing.length) sections.push(`**削除済み/不明**\n${missing.map((id) => `• ${id}`).join('\n')}`);

        await interaction.reply({ content: sections.join('\n\n'), ephemeral: true });
        return;
      }

      if (interaction.commandName === '認証権限反映') {
        await interaction.deferReply({ ephemeral: true });
        const result = await applyVerificationVisibility(interaction.guild);
        await interaction.editReply(
          `権限を反映しました。\n` +
          `認証前から見える: ${result.visibleCount}\n` +
          `認証完了まで見えない: ${result.hiddenCount}\n` +
          `Bot管理外（変更なし）: ${result.untouchedCount}\n` +
          `変更失敗: ${result.failedCount}`,
        );
        return;
      }

      if (interaction.commandName === '認証前ロール設定') {
        await interaction.deferReply({ ephemeral: true });
        const role = interaction.options.getRole('ロール', true);
        const colorInput = interaction.options.getString('色');

        await ensureRoleManageable(interaction.guild, role);
        const color = normalizeHexColor(colorInput);
        if (color) {
          await role.setColors({ primaryColor: color }, `認証Bot: ${interaction.user.tag} が認証前ロール色を変更`);
        }

        config.preVerificationRoleId = role.id;
        saveConfig();

        const colorHex = role.hexColor === '#000000' ? 'デフォルト' : role.hexColor;
        await interaction.editReply(
          `認証前ロールを ${role} に設定しました。\n` +
          `ロール名: ${role.name}\n` +
          `色: ${colorHex}\n` +
          '新しく参加したユーザーには自動でこのロールを付与し、認証時に外します。',
        );
        return;
      }

      if (interaction.commandName === '認証前ロール確認') {
        const role = await getPreVerificationRole(interaction.guild);
        if (!role) {
          await interaction.reply({ content: '認証前ロールはまだ設定されていません。', ephemeral: true });
          return;
        }
        const colorHex = role.hexColor === '#000000' ? 'デフォルト' : role.hexColor;
        await interaction.reply({
          content: `認証前ロール: ${role}\nロール名: ${role.name}\n色: ${colorHex}`,
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === '認証前ロール配布') {
        await interaction.deferReply({ ephemeral: true });
        const preRole = await getPreVerificationRole(interaction.guild);
        if (!preRole) {
          await interaction.editReply('先に /認証前ロール設定 を実行してください。');
          return;
        }
        await ensureRoleManageable(interaction.guild, preRole);
        const verifiedRole = await interaction.guild.roles.fetch(envConfig.verifiedRoleId);
        if (!verifiedRole) {
          await interaction.editReply('認証済みロールが見つかりません。');
          return;
        }

        await interaction.guild.members.fetch();
        let added = 0;
        let skipped = 0;
        let failed = 0;
        for (const member of interaction.guild.members.cache.values()) {
          if (member.user.bot || member.roles.cache.has(verifiedRole.id) || member.roles.cache.has(preRole.id)) {
            skipped += 1;
            continue;
          }
          try {
            await addRoleAndConfirm(member, preRole, '認証Bot: 既存の未認証メンバーへ配布');
            added += 1;
          } catch (error) {
            failed += 1;
            console.error(`認証前ロール配布失敗: ${member.user.tag}`, error);
          }
        }

        await interaction.editReply(`配布完了。\n付与: ${added}\nスキップ: ${skipped}\n失敗: ${failed}`);
        return;
      }

      if (interaction.commandName === 'ロール診断') {
        await interaction.deferReply({ ephemeral: true });

        await interaction.guild.roles.fetch();
        const me = await interaction.guild.members.fetchMe({ force: true });
        const verifiedRole = await interaction.guild.roles.fetch(envConfig.verifiedRoleId);
        const preRole = await getPreVerificationRole(interaction.guild);

        if (!verifiedRole) {
          await interaction.editReply('❌ VERIFIED_ROLE_ID の認証済みロールが見つかりません。');
          return;
        }

        const lines = [];
        lines.push(`Bot最高ロール: ${me.roles.highest} (${me.roles.highest.position})`);
        lines.push(`ロールの管理権限: ${me.permissions.has(PermissionFlagsBits.ManageRoles) ? 'OK' : 'NG'}`);

        try {
          await ensureRoleManageable(interaction.guild, verifiedRole);
          lines.push(`認証済みロール ${verifiedRole}: 付与可能`);
        } catch (error) {
          lines.push(`認証済みロール ${verifiedRole}: NG - ${error.message}`);
        }

        if (preRole) {
          try {
            await ensureRoleManageable(interaction.guild, preRole);
            lines.push(`認証前ロール ${preRole}: 付与/解除可能`);
          } catch (error) {
            lines.push(`認証前ロール ${preRole}: NG - ${error.message}`);
          }
        } else {
          lines.push('認証前ロール: 未設定');
        }

        await interaction.editReply(lines.join('\n'));
        return;
      }

      return;
    }

    if (interaction.isButton() && interaction.customId === 'verify_member') {
      if (!interaction.inGuild()) return;

      await interaction.deferReply({ ephemeral: true });

      const role = await interaction.guild.roles.fetch(envConfig.verifiedRoleId);
      if (!role) {
        await interaction.editReply('認証ロールが見つかりません。.env の VERIFIED_ROLE_ID を確認してください。');
        return;
      }

      const me = interaction.guild.members.me;
      if (!me) {
        await interaction.editReply('Botメンバー情報を取得できませんでした。');
        return;
      }

      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.editReply('Botに「ロールの管理」権限がありません。');
        return;
      }

      if (role.position >= me.roles.highest.position) {
        await interaction.editReply('認証ロールをBotの一番上のロールより下に移動してください。');
        return;
      }

      let member = await fetchFreshMember(interaction.guild, interaction.user.id);
      const preRole = await getPreVerificationRole(interaction.guild);

      if (!member.roles.cache.has(role.id)) {
        member = await addRoleAndConfirm(member, role, '認証ボタンによる認証');
      }

      let removedPreRole = false;
      if (preRole) {
        member = await fetchFreshMember(interaction.guild, interaction.user.id);
        if (member.roles.cache.has(preRole.id)) {
          member = await removeRoleAndConfirm(member, preRole, '認証完了により認証前ロールを解除');
          removedPreRole = true;
        }
      }

      const finalMember = await fetchFreshMember(interaction.guild, interaction.user.id);
      if (!finalMember.roles.cache.has(role.id)) {
        throw new Error(`認証後の再確認で「${role.name}」ロールが見つかりませんでした。`);
      }

      console.log(`認証ロール反映OK: ${interaction.user.tag} -> ${role.name}`);
      await interaction.editReply(
        `✅ 認証完了！「${role.name}」ロールの反映を確認しました。` +
        (removedPreRole ? `\n「${preRole.name}」ロールも解除済みです。` : ''),
      );
    }
  } catch (error) {
    console.error(error);

    const errorText = error instanceof Error ? error.message : String(error);
    const message = `処理中にエラーが発生しました。\n${errorText}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

try {
  await registerCommands();
  await client.login(envConfig.token);
} catch (error) {
  console.error('起動に失敗しました。', error);
  process.exit(1);
}
