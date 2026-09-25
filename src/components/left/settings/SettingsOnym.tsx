import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { createStyledQrCode } from '../../../util/qrCode/buildStyledQrCode';
import { callApi } from '../../../api/gramjs';

import useAsync from '../../../hooks/useAsync';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import Button from '../../ui/Button';
import ListItem from '../../ui/ListItem';

import styles from './SettingsOnym.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type OnymIdentity = {
  inviteLink: string;
  inboxKey: string;
  stellarAccount: string;
  blsPublicKey: string;
  relays: string[];
  defaultRelays: string[];
};

const QR_SIZE = 240;

// The identity surfaces of an Onym interface: the invite link others add you by, the recovery phrase behind a
// deliberate gesture (it is the whole identity), the relays in use, and what this interface does not check
const SettingsOnym = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const qrRef = useRef<HTMLDivElement>();
  const [identity, setIdentity] = useState<OnymIdentity>();
  const [phrase, setPhrase] = useState<string | undefined>();

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (!isActive) {
      setPhrase(undefined);
      return;
    }
    void callApi('fetchOnymIdentity').then(setIdentity);
  }, [isActive]);

  const { result: qrCode } = useAsync(() => createStyledQrCode({ size: QR_SIZE }), []);

  useLayoutEffect(() => {
    if (!qrCode || !identity?.inviteLink || !qrRef.current) return;
    qrCode.update({ data: identity.inviteLink });
    if (!qrRef.current.childElementCount) qrCode.append(qrRef.current);
  }, [qrCode, identity?.inviteLink]);

  // The Onym app's paste field takes the bare 64-character key; its QR scanner also reads the link
  const handleCopyKey = useLastCallback(() => {
    if (!identity) return;
    copyTextToClipboard(identity.inboxKey);
    showNotification({ message: lang('OnymKeyCopied') });
  });

  const handleCopyLink = useLastCallback(() => {
    if (!identity) return;
    copyTextToClipboard(identity.inviteLink);
    showNotification({ message: lang('OnymLinkCopied') });
  });

  const handleShowPhrase = useLastCallback(async () => {
    setPhrase(await callApi('fetchOnymPhrase'));
  });

  const handleHidePhrase = useLastCallback(() => {
    setPhrase(undefined);
  });

  return (
    <div className={styles.root}>
      <Island>
        <IslandTitle>{lang('OnymInviteLinkTitle')}</IslandTitle>
        <div className={styles.qr} ref={qrRef} />
        <div className={styles.link}>{identity?.inboxKey}</div>
        <Button className={styles.button} onClick={handleCopyKey} disabled={!identity}>
          {lang('OnymCopyKey')}
        </Button>
        <Button className={styles.button} isText onClick={handleCopyLink} disabled={!identity}>
          {lang('OnymCopyLink')}
        </Button>
      </Island>
      <IslandDescription>{lang('OnymInviteLinkDesc')}</IslandDescription>

      <Island>
        <IslandTitle>{lang('OnymRecoveryPhrase')}</IslandTitle>
        {phrase ? (
          <>
            <ol className={styles.phrase}>
              {phrase.split(' ').map((word, i) => <li key={`${i}-${word}`}>{word}</li>)}
            </ol>
            <Button className={styles.button} isText onClick={handleHidePhrase}>{lang('OnymHidePhrase')}</Button>
          </>
        ) : (
          <Button className={styles.button} onClick={handleShowPhrase}>{lang('OnymShowPhrase')}</Button>
        )}
      </Island>
      <IslandDescription>{lang('OnymRecoveryPhraseDesc')}</IslandDescription>

      <Island>
        <IslandTitle>{lang('OnymRelays')}</IslandTitle>
        {identity?.relays.map((relay) => (
          <ListItem key={relay} icon="link" narrow inactive multiline>
            <span className="title">{relay}</span>
            {identity.defaultRelays.includes(relay) && <span className="subtitle">{lang('OnymDefaultRelay')}</span>}
          </ListItem>
        ))}
      </Island>
      <IslandDescription>{lang('OnymRelaysDesc')}</IslandDescription>

      <Island>
        <IslandTitle>{lang('OnymPublicKeys')}</IslandTitle>
        <ListItem icon="key" narrow inactive multiline>
          <span className="title">{identity?.stellarAccount}</span>
          <span className="subtitle">{lang('OnymStellarAccount')}</span>
        </ListItem>
        <ListItem icon="key" narrow inactive multiline>
          <span className={buildClassName('title', styles.key)}>{identity?.blsPublicKey}</span>
          <span className="subtitle">{lang('OnymMemberKey')}</span>
        </ListItem>
      </Island>
      <IslandDescription>{lang('OnymAboutInterface')}</IslandDescription>
    </div>
  );
};

export default memo(SettingsOnym);
