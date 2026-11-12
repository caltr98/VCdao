// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
    Contratto che gestisce la governance della DAO, ovvero l'intero ciclo di vita
    delle proposte di investimento: proposeWithTopic → vote → queue → (delay) → execute.

    Eredita 7 moduli OpenZeppelin che lavorano insieme:
    Governor (core): Fornisce la struttura di base per gestire le proposte.
    GovernorSettings: Fornisce i parametri di voto: votingDelay, votingPeriod, threshold.
    GovernorCountingSimple: Fornisce le funzioni di conteggio: For / Against / Abstain.
    GovernorVotes: Collega il token ERC20Votes al Governor.
    GovernorVotesQuorumFraction: Gestisce i parametri di quorum in % della supply totale.
    GovernorVotesSuperQuorumFraction: Gestisce il superquorum per l'approvazione rapida.
    GovernorTimelockControl: Gestisce il timelock, che fornisce un delay di sicurezza prima dell'esecuzione.

    Novità della versione multi-topic:
    ogni proposta è associata a un topicId tramite proposeWithTopic().
    Il voting power usato per votare una proposta non è solo il balance ERC20Votes, ma:
        VP = stakeVP(account, snapshot) + skillVP(account, topicId, snapshot)
    Anche quorum e superquorum vengono calcolati sulla supply totale del topic specifico:
        supplyTopic = supplyStake + supplySkill(topicId)

    Il flusso di esecuzione di una proposta è il seguente:
    1. proposeWithTopic() → crea la proposta, salva il topicId, stato = Pending
    2. (voting delay passa) → stato = Active
    3. castVote() / castVoteWithReasonAndParams() → i membri votano For/Against/Abstain
    4. (voting period finisce) → stato = Succeeded o Defeated
       OPPURE: se il superquorum del topic viene raggiunto → Succeeded prima della scadenza!
    5. queue() → mette la proposta nel Timelock (stato = Queued)
    6. (timelock delay passa)
    7. execute() → il Timelock esegue l'operazione (stato = Executed)
*/

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesSuperQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./IGovernanceToken.sol";
import "./IGovernanceSkill.sol";

contract MyGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorVotesSuperQuorumFraction,
    GovernorTimelockControl
{
    // =========================================================================
    //  Stato
    // =========================================================================

    /// Riferimenti tipizzati ai moduli di stake e skill usati dal Governor.
    IGovernanceToken public immutable governanceToken;
    IGovernanceSkill public immutable governanceSkill;


    /*
    Mapping che associa ogni proposalId al suo topicId.
    Viene impostato quando una proposta viene creata con proposeWithTopic().
    Viene usato quando si vuole recuperare il topicId di una proposta, in modo da
    recuperare la supply del voting power legato alle skill di un topic. 
    */
    mapping(uint256 => uint256) public proposalTopic;

    // =========================================================================
    //  Errori
    // =========================================================================

    error InvalidTopicId(uint256 topicId);
    error UseProposeWithTopic();
    error InvalidVoteParams();
    error InvalidWeights();

    /// Emesso quando una proposta viene creata con il topic su cui verrà calcolato il VP skill.
    event ProposalTopicSet(uint256 indexed proposalId, uint256 indexed topicId);

    // =========================================================================
    //  Costruttore
    // =========================================================================

    /*  Il costruttore riceve in input il Token ERC20Votes, il TimelockController,
        il numero di blocchi di attesa prima dell'inizio del voto, la durata della
        finestra di voto, la soglia minima di voti per poter creare una proposta,
        il quorum in % della supply totale votabile al blocco di snapshot della proposta
        e il superquorum.

        Nella nuova versione multi-topic, quorum e superquorum vengono poi applicati
        alla supply del topic della proposta, ma i numeratori percentuali restano quelli
        configurati qui. I contratti ereditati vengono inizializzati con tali parametri.

        @param token_                Token ERC20Votes (chi lo possiede può votare)
        @param timelock_             TimelockController (delay di sicurezza)
        @param votingDelay_          Blocchi/secondi di attesa prima dell'inizio del voto
        @param votingPeriod_         Durata della finestra di voto
        @param proposalThreshold_    Voti minimi per creare una proposta
        @param quorumNumerator_      Quorum in % (es. 4 = 4% della supply)
        @param superQuorumNumerator_ Superquorum in % (es. 20 = 20%, deve essere >= quorum)
    */
    constructor(
        IGovernanceToken token_,
        IGovernanceSkill skill_,
        TimelockController timelock_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumNumerator_,
        uint256 superQuorumNumerator_
    )
        Governor("MyGovernor")
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(quorumNumerator_)
        GovernorVotesSuperQuorumFraction(superQuorumNumerator_)
        GovernorTimelockControl(timelock_)
    {
        governanceToken = token_;
        governanceSkill = skill_;
    }

    // =========================================================================
    //  Creazione proposte con topic
    // =========================================================================

    /*
    Funzione che crea una proposta associandola a un topicId.
    Sostituisce propose() nella nuova versione della DAO, perché ogni proposta deve
    dichiarare l'ambito di competenza tramite topicId, su cui viene poi calcolato il VP skill, quorum e superquorum.
    Il topic viene salvato in proposalTopic[proposalId] e poi usato automaticamente
    durante il voto.
    La funzione verifica che il topicId sia valido, chiama super.propose() per creare la proposta
    e poi salva il topicId in proposalTopic[proposalId].
    @param topicId  Topic riconosciuto da GovernanceSkill
    */
    function proposeWithTopic(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        uint256 topicId
    ) public virtual returns (uint256 proposalId) {
        _validateTopicId(topicId);
        proposalId = super.propose(targets, values, calldatas, description);
        proposalTopic[proposalId] = topicId;
        emit ProposalTopicSet(proposalId, topicId);
    }


    /*
    Funzione propose standard disabilitata, poichè per il calcolo del vp skill
    è necessario conoscere il topicId.
    */
    function propose(
        address[] memory,
        uint256[] memory,
        bytes[] memory,
        string memory
    ) public pure override returns (uint256) {
        revert UseProposeWithTopic();
    }

    /*
Override di castVote che ignora i params ricevuti, e chiama super._castVote 
passando come parametro il topicId salvato in proposalTopic[proposalId]. 
*/
    function _castVote(
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory /* params */
    ) internal override returns (uint256) {
        // Inietta il topicId corretto dalla storage, ignorando i params del chiamante.
        // In questo modo anche castVote() standard diventa topic-aware.
        bytes memory topicParams = abi.encode(proposalTopic[proposalId]);
        return
            super._castVote(proposalId, account, support, reason, topicParams);
    }

     /*
    Funzione di lettura del voting power di un membro, usata dal Governor durante il voto.
    VP_totale(account, timepoint, topic) = token.getPastVotes(account, timepoint)                        [stake]
                 + governanceSkill.getPastSkillVotes(account, topic, timepoint)
    Il timepoint è il blocco di snapshot della proposta. Gli upgrade o i depositi successivi non alterano votazioni già iniziate.
    La funzione prende in input l'account del membro, il blocco di snapshot della proposta e i parametri della proposta, in cui è contenuto il topicId.
    Si prendono i voti di stake usando la funzione getVotes() di ERC20Votes. Se i parametri sono vuoti, la funzione ritorna solo i voti provenienti da stake.
    Altrimenti si decodifica il topicId dai parametri della proposta, si verifica che sia valido,
    e si recupera dal checkpoint che salva le skill di un membro, il voting power derivato da skill
    del membro nel topic della proposta, in quel tale timepoint. Si ritorna la somma tra voting power derivato da stake e da skill. 
    */
    function _getVotes(
        address account,
        uint256 timepoint,
        bytes memory params
    ) internal view override(Governor, GovernorVotes) returns (uint256) {
        if (!governanceToken.isMember(account)) {
            return 0;
        }

        uint256 stakeVotes = super._getVotes(account, timepoint, params);

        if (params.length == 0) {
            return stakeVotes;
        }
        if (params.length != 32) revert InvalidVoteParams();

        uint256 topicId = abi.decode(params, (uint256));
        _validateTopicId(topicId);
        uint256 skillVotes = governanceSkill.getPastSkillVotes(
            account,
            topicId,
            timepoint
        );

        return stakeVotes + skillVotes;
    }

    /*
    Precedentemente il quorum era calcolato solo come percentuale della supply totale del token. 
    Ora, invece, ogni proposta usa la supply votabile del proprio topic:
    supplyTopic = supplyStake + supplySkill(topicId).
    Problema: La funzione quorum(timepoint) non riceve il proposalId, quindi non conosce
    il topic. Soluzione: _quorumReached e state() hanno accesso al proposalId
    e applicano il calcolo topic-aware. quorum(timepoint) resta disponibile
    solo per compatibilità interfaccia/display.
    */

    /*
    Funzione che calcola la total supply votabile per un topic: supplyTopic = supplyStake + supplySkill(topicId).
    Sulla total supply vengono applicate le percentuali di quorum e superquorum.
    La funzione recupera dai checkpoint di ERC20Votes e dal checkpoint di skillTopicVotingPower la total supply ad un certo timepoint.
    */
    function _totalVotingPowerForTopic(
        uint256 topicId,
        uint256 timepoint
    ) internal view returns (uint256) {
        uint256 stakeSupply = governanceToken.getPastTotalSupply(timepoint); //supply storica del token
        uint256 skillSupply = governanceSkill.getPastTotalSkillSupply(
            topicId,
            timepoint
        ); //supply skill storica del topic
        return stakeSupply + skillSupply;
    }

    /// Getter pubblico della supply totale votabile per un topic a un timepoint.
    function totalVotingPowerForTopic(
        uint256 topicId,
        uint256 timepoint
    ) public view returns (uint256) {
        _validateTopicId(topicId);
        return _totalVotingPowerForTopic(topicId, timepoint);
    }

    /*
    Funzione che calcola il quorum del topic al timepoint.
    Recupera la total supply tramite la funzione precedente e applica la percentuale di quorum.
    Es: se la supply totale topic-specifica è 1.000 VP e il quorumNumerator è 4,
    il quorum richiesto è 40 VP.
    */
    function _quorumForTopic(
        uint256 topicId,
        uint256 timepoint
    ) internal view returns (uint256) {
        return
            Math.mulDiv(
                _totalVotingPowerForTopic(topicId, timepoint),
                quorumNumerator(timepoint),
                quorumDenominator()
            );
    }

    /// Getter pubblico del quorum assoluto per topic e timepoint.
    function quorumForTopic(
        uint256 topicId,
        uint256 timepoint
    ) public view returns (uint256) {
        _validateTopicId(topicId);
        return _quorumForTopic(topicId, timepoint);
    }

    /// Restituisce il quorum richiesto per una proposta usando il suo topic e snapshot.
    //  Recupera il topic relativo alla proposta dal mapping e il timepoint del momento in cui la proposta è stata creata. Chiama la funzione per il calcolo del quorum.
    function quorumForProposal(
        uint256 proposalId
    ) public view returns (uint256) {
        return
            _quorumForTopic(
                proposalTopic[proposalId],
                proposalSnapshot(proposalId) //snapshot del momento in cui la proposta è stata creata
            );
    }


   /*
    Calcola il superquorum assoluto del topic al timepoint.
    Il superquorum permette a una proposta molto supportata di risultare riuscita
    prima della fine naturale del votingPeriod, ma sempre rispettando il topic.
    */
    function _superQuorumForTopic(
        uint256 topicId,
        uint256 timepoint
    ) internal view returns (uint256) {
        return
            Math.mulDiv(
                _totalVotingPowerForTopic(topicId, timepoint),
                superQuorumNumerator(timepoint),
                quorumDenominator()
            );
    }

    /// Getter pubblico del superquorum assoluto per topic e timepoint.
    function superQuorumForTopic(
        uint256 topicId,
        uint256 timepoint
    ) public view returns (uint256) {
        _validateTopicId(topicId);
        return _superQuorumForTopic(topicId, timepoint);
    }

    /// Restituisce il superquorum richiesto per una proposta usando il suo topic e snapshot.
    function superQuorumForProposal(
        uint256 proposalId
    ) public view returns (uint256) {
        return
            _superQuorumForTopic(
                proposalTopic[proposalId],
                proposalSnapshot(proposalId)
            );
    }

    /// Controlla che il topic esista in GovernanceSkill.
    function _validateTopicId(uint256 topicId) internal view {
        if (!governanceSkill.isValidTopic(topicId))
            revert InvalidTopicId(topicId);
    }


   /*
    Override della funzione _quorumReached, che decide se una proposta ha superato il quorum.
    Sostituisce GovernorCountingSimple._quorumReached che chiamerebbe quorum(timepoint).
    Recupera il timepoint di snapshot della proposta e il topicId dal relativo mapping.
    Calcola il quorum relativo al topic della proposta usando la funzione ad hoc precedente.
    Recupera il numero di voti che hanno votato FOR e Abstain per la proposta. Confronta questo numero
    con il quorum sulla total supply di voting power. Se supera q, la proposta è valida.
    */
    function _quorumReached(
        uint256 proposalId
    ) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        uint256 snapshot = proposalSnapshot(proposalId);
        uint256 topicId = proposalTopic[proposalId];
        uint256 q = _quorumForTopic(topicId, snapshot);

        (, uint256 forVotes, uint256 abstainVotes) = proposalVotes(proposalId);
        return q <= forVotes + abstainVotes;
    }

    /*
    _superQuorumReached rimosso: in OpenZeppelin 5.4 GovernorSuperQuorum non usa più
    quel hook. La logica topic-specifica del superquorum viene quindi incorporata
    direttamente nell'override di state().
    */

    /*
    quorum(timepoint) — compatibilità interfaccia IGovernor.
    Ritorna il quorum sulla sola supply stake (conservativo, per display esterno).
    L'enforcement reale avviene in _quorumReached.
    */
    function quorum(
        uint256 timepoint
    )
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return
            Math.mulDiv(
                governanceToken.getPastTotalSupply(timepoint),
                quorumNumerator(timepoint),
                quorumDenominator()
            );
    }

    /*
    superQuorum(timepoint) — compatibilità display.
    Come quorum(), usa solo la supply stake.
    L'enforcement reale del superquorum topic-specifico avviene in state().
    */
    function superQuorum(
        uint256 timepoint
    ) public view override returns (uint256) {
        return
            Math.mulDiv(
                governanceToken.getPastTotalSupply(timepoint),
                superQuorumNumerator(timepoint),
                quorumDenominator()
            );
    }

    // =========================================================================
    //  Override richiesti da Solidity per risolvere conflitti di ereditarietà.
    //
    //  Il contratto eredita più moduli OpenZeppelin che definiscono funzioni con
    //  lo stesso nome. Per questo motivo Solidity richiede override espliciti per
    //  votingDelay, votingPeriod, proposalThreshold, quorum, clock, state,
    //  Timelock e aggiornamento quorum.
    // Guardare state() per calcolo del superquorum.
    // =========================================================================

    // ----- Parametri di governance (GovernorSettings <-> Governor) -----

    /// @notice Ritardo prima dell'inizio della votazione.
    /// @dev Override necessario: sia Governor che GovernorSettings definiscono questa funzione.
    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    /// @notice Durata della finestra di voto.
    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    /// @notice Soglia minima di voti per poter creare una proposta.
    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    // ----- Clock (GovernorVotes <-> Governor) -----

    /// @notice Clock corrente (blocco o timestamp, dipende dal token).
    function clock()
        public
        view
        override(Governor, GovernorVotes)
        returns (uint48)
    {
        return super.clock();
    }

    /// @notice Modalità del clock (es. "mode=blocknumber&from=default").
    function CLOCK_MODE()
        public
        view
        override(Governor, GovernorVotes)
        returns (string memory)
    {
        return super.CLOCK_MODE();
    }

    // ----- Conteggio voti (GovernorCountingSimple <-> GovernorSuperQuorum) -----

    /// @notice Restituisce i voti di una proposta: contrari, favorevoli, astenuti.
    /// @dev Serve sia a GovernorCountingSimple (conteggio) sia a GovernorSuperQuorum.
    function proposalVotes(
        uint256 proposalId
    )
        public
        view
        override(GovernorCountingSimple, GovernorSuperQuorum)
        returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)
    {
        return super.proposalVotes(proposalId);
    }

    // ----- Stato della proposta (SuperQuorumFraction <-> TimelockControl) -----

    /*
    Funzione che decide lo stato attuale di una proposta.
    Può restituire stati come: Pending, Active, Succeeded, Defeated, Queued, Executed, Canceled.
    Adattamento:durante lo stato Active, il numero di voti attuali viene confrontato con il superquorum
    calcolato sulla supply del topic della proposta.
    Lo stato attuale della proposta viene recuperato da .state() di Governor.
    Se lo stato è Active, si verifica se il superquorum è raggiunto usando la formula custom.
    Se i voti FOR sono maggiori del superquorum della totalsupply, e se sono maggiori dei voti against,
    la proposta passa allo stato Succeeded, usando .state() di GovernorSuperQuorumFraction. 
    Altrimenti resta in Active.

   */
    function state(
        uint256 proposalId
    )
        public
        view
        override(
            Governor,
            GovernorVotesSuperQuorumFraction,
            GovernorTimelockControl
        )
        returns (ProposalState)
    {
        ProposalState baseState = Governor.state(proposalId);

        if (baseState == ProposalState.Active) {
            (, uint256 forVotes, ) = proposalVotes(proposalId);
            uint256 topicId = proposalTopic[proposalId];
            uint256 sq = _superQuorumForTopic(
                topicId,
                proposalSnapshot(proposalId)
            );

            if (forVotes >= sq && _voteSucceeded(proposalId)) {
                // Delegando a super.state, sfruttiamo GovernorTimelockControl
                // per ottenere il corretto stato (Succeeded/Queued/Executed).
                // Siccome sq (Topic) >= stakeSQ (Token), OZ riconoscerà il superquorum.
                return super.state(proposalId);
            }
            // Blocca early execution prematura causata dallo stakeSQ inferiore
            return ProposalState.Active;
        }

        return super.state(proposalId);
    }

    // ----- Timelock: coda, esecuzione, cancellazione -----

    /// @notice Indica se la proposta necessita di essere messa in coda (timelock).
    /// @dev Ritorna true perché usiamo GovernorTimelockControl.
    function proposalNeedsQueuing(
        uint256 proposalId
    ) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    /// @notice Mette in coda le operazioni della proposta nel TimelockController.
    /// @dev Viene chiamata internamente da queue().
    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return
            super._queueOperations(
                proposalId,
                targets,
                values,
                calldatas,
                descriptionHash
            );
    }

    /// @notice Esegue le operazioni della proposta tramite il TimelockController.
    /// @dev Viene chiamata internamente da execute().
    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(
            proposalId,
            targets,
            values,
            calldatas,
            descriptionHash
        );
    }

    /// @notice Cancella una proposta e rimuove l'operazione dal timelock se in coda.
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    /// @notice Indirizzo che esegue le azioni (il TimelockController).
    /// @dev Le azioni NON vengono eseguite dal Governor ma dal Timelock.
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    // ----- Aggiornamento quorum (QuorumFraction <-> SuperQuorumFraction) -----

    /// @notice Aggiorna il numeratore del quorum.
    /// @dev Assicura che il quorum resti compatibile con il superquorum.
    function _updateQuorumNumerator(
        uint256 newQuorumNumerator
    )
        internal
        override(GovernorVotesQuorumFraction, GovernorVotesSuperQuorumFraction)
    {
        super._updateQuorumNumerator(newQuorumNumerator);
    }
}
