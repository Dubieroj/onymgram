import { memo, useState } from '../../lib/teact/teact';

import { callApi } from '../../api/gramjs';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import TextArea from '../ui/TextArea';

import './AuthOnym.scss';

type Step = 'start' | 'create' | 'restore';

const PROBLEM_KEYS = {
  length: 'OnymPhraseProblemLength',
  word: 'OnymPhraseProblemWord',
  checksum: 'OnymPhraseProblemChecksum',
} as const;

// Replaces the phone-number screen: an Onym identity is a BIP-39 phrase held by its owner, and the phrase itself
// never enters global state (which is cached), only this component and the API worker
const AuthOnym = () => {
  const lang = useLang();
  const [step, setStep] = useState<Step>('start');
  const [phrase, setPhrase] = useState('');
  const [isSaved, setIsSaved] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleCreate = useLastCallback(async () => {
    setIsLoading(true);
    const generated = await callApi('generateOnymPhrase');
    setIsLoading(false);
    if (!generated) return;
    setPhrase(generated);
    setIsSaved(false);
    setStep('create');
  });

  const handleRestore = useLastCallback(() => {
    setPhrase('');
    setError(undefined);
    setStep('restore');
  });

  const handleBack = useLastCallback(() => {
    setPhrase('');
    setError(undefined);
    setStep('start');
  });

  const handlePhraseChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPhrase(e.target.value);
    setError(undefined);
  });

  const handleSubmit = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    setIsLoading(true);
    const result = await callApi('provideOnymPhrase', phrase);
    setIsLoading(false);
    if (result?.problem) {
      setError(lang(PROBLEM_KEYS[result.problem]));
    }
  });

  return (
    <div id="auth-onym-form" className="custom-scroll">
      <div className="auth-form">
        <div id="logo" />
        <h1>Onymgram</h1>
        {step === 'start' && (
          <>
            <p className="note">{lang('OnymLoginNote')}</p>
            <Button onClick={handleCreate} isLoading={isLoading} ripple>{lang('OnymCreateIdentity')}</Button>
            <Button isText onClick={handleRestore} ripple>{lang('OnymEnterPhrase')}</Button>
          </>
        )}
        {step === 'create' && (
          <>
            <p className="note">{lang('OnymWriteDownPhrase')}</p>
            <ol className="onym-phrase">
              {phrase.split(' ').map((word, i) => <li key={`${i}-${word}`}>{word}</li>)}
            </ol>
            <Checkbox label={lang('OnymPhraseSaved')} checked={isSaved} onCheck={setIsSaved} />
            <Button onClick={handleSubmit} disabled={!isSaved} isLoading={isLoading} ripple>
              {lang('Next')}
            </Button>
            <Button isText onClick={handleBack}>{lang('Back')}</Button>
          </>
        )}
        {step === 'restore' && (
          <form action="" onSubmit={handleSubmit}>
            <p className="note">{lang('OnymEnterPhraseNote')}</p>
            <TextArea
              id="onym-phrase-input"
              label={lang('OnymRecoveryPhrase')}
              value={phrase}
              error={error}
              autoComplete="off"
              onChange={handlePhraseChange}
            />
            <Button type="submit" disabled={!phrase.trim()} isLoading={isLoading} ripple>{lang('Next')}</Button>
            <Button isText onClick={handleBack}>{lang('Back')}</Button>
          </form>
        )}
      </div>
    </div>
  );
};

export default memo(AuthOnym);
