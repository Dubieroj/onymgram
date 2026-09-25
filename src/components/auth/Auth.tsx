import '../../global/actions/initial';

import { memo } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';

import useCurrentOrPrev from '../../hooks/useCurrentOrPrev';

import Transition from '../ui/Transition';
import AuthCode from './AuthCode.async';
import AuthOnym from './AuthOnym';
import AuthPassword from './AuthPassword.async';
import AuthRegister from './AuthRegister.async';

import './Auth.scss';

type StateProps = {
  authState: GlobalState['auth']['state'];
};

const Auth = ({
  authState,
}: StateProps) => {
  // For animation purposes
  const renderingAuthState = useCurrentOrPrev(
    authState !== 'authorizationStateReady' ? authState : undefined,
    true,
  );

  function getScreen() {
    switch (renderingAuthState) {
      case 'authorizationStateWaitCode':
        return <AuthCode />;
      case 'authorizationStateWaitPassword':
        return <AuthPassword />;
      case 'authorizationStateWaitRegistration':
        return <AuthRegister />;
      default:
        return <AuthOnym />;
    }
  }

  function getActiveKey() {
    switch (renderingAuthState) {
      case 'authorizationStateWaitCode':
        return 0;
      case 'authorizationStateWaitPassword':
        return 1;
      case 'authorizationStateWaitRegistration':
        return 2;
      default:
        return 3;
    }
  }

  return (
    <Transition
      activeKey={getActiveKey()}
      name="fade"
      className="Auth"
      data-tauri-drag-region={IS_TAURI && IS_MAC_OS ? true : undefined}
    >
      {getScreen()}
    </Transition>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      authState: global.auth.state,
    };
  },
)(Auth));
