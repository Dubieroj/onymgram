import {
  memo, useEffect, useState,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import Button from '../../ui/Button';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';

import styles from './SettingsOnym.module.scss';

type OwnProps = {
  kind: 'relay' | 'blossom';
  isActive?: boolean;
  onReset: () => void;
};

type Servers = { list: string[]; defaults: string[] };

// The carriers this interface uses, replaceable in place: the defaults are labelled as defaults, any list the user
// writes replaces them, and at least one entry always remains (Interface.md §4.2, §6)
const SettingsOnymServers = ({ kind, isActive, onReset }: OwnProps) => {
  const lang = useLang();
  const [servers, setServers] = useState<Servers>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (!isActive) return;
    void callApi('fetchOnymSettings').then((settings) => {
      if (!settings) return;
      setServers(kind === 'relay'
        ? { list: settings.relays, defaults: settings.defaultRelays }
        : { list: settings.blossomServers, defaults: settings.defaultBlossomServers });
    });
  }, [isActive, kind]);

  const save = useLastCallback(async (list: string[]) => {
    const result = await callApi('setOnymServers', kind, list);
    if (!result || !result.list) {
      setError(lang(kind === 'relay' ? 'OnymRelayInvalid' : 'OnymBlossomInvalid'));
      return false;
    }
    setServers((current) => current && { ...current, list: result.list });
    setError(undefined);
    return true;
  });

  const handleAdd = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!servers || !draft.trim()) return;
    if (await save([...servers.list, draft])) setDraft('');
  });

  const handleRemove = useLastCallback((server: string) => {
    if (!servers || servers.list.length < 2) return;
    void save(servers.list.filter((item) => item !== server));
  });

  const handleRestore = useLastCallback(() => {
    if (servers) void save(servers.defaults);
  });

  const handleDraftChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
    setError(undefined);
  });

  const isDefaultList = servers && servers.list.join(' ') === servers.defaults.join(' ');

  return (
    <div className={styles.root}>
      <Island>
        <IslandTitle>{lang(kind === 'relay' ? 'OnymNostrRelays' : 'OnymBlossomServers')}</IslandTitle>
        {servers?.list.map((server) => (
          <ListItem
            key={server}
            icon={kind === 'relay' ? 'link' : 'photo'}
            narrow
            multiline
            inactive={servers.list.length < 2}
            rightElement={servers.list.length > 1 ? (
              <Button isText size="tiny" fluid onClick={() => handleRemove(server)}>{lang('OnymRemove')}</Button>
            ) : undefined}
          >
            <span className={buildClassName('title', styles.server)}>{server}</span>
            {servers.defaults.includes(server) && <span className="subtitle">{lang('OnymDefaultRelay')}</span>}
          </ListItem>
        ))}
        <form className={styles.addServer} action="" onSubmit={handleAdd}>
          <InputText
            value={draft}
            label={lang(kind === 'relay' ? 'OnymRelayPlaceholder' : 'OnymBlossomPlaceholder')}
            error={error}
            onChange={handleDraftChange}
          />
          <Button className={styles.button} type="submit" disabled={!draft.trim()}>{lang('OnymAddServer')}</Button>
        </form>
        {!isDefaultList && (
          <Button className={styles.button} isText onClick={handleRestore}>{lang('OnymRestoreDefaults')}</Button>
        )}
      </Island>
      <IslandDescription>{lang(kind === 'relay' ? 'OnymRelaysNote' : 'OnymBlossomNote')}</IslandDescription>
    </div>
  );
};

export default memo(SettingsOnymServers);
